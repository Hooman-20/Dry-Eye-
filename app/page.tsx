"use client";

import { useEffect, useReducer, useRef, useState } from "react";

declare global {
  interface Window {
    FaceMesh?: any;
  }
}
export {};

type Point = { x: number; y: number };

type SessionSummary = {
  totalBlinks: number;
  totalVisibleTimeMs: number;
  totalHiddenTimeMs: number;
  totalSessionTimeMs: number;
  averageBlinksPerMinute: number;

  totalAlerts: number;
  longestNoBlinkMs: number;
  visibilityPercent: number;
  blinkCompliancePercent: number;

  score: number;
  grade: string;
  gradeReason: string;
};

function dist(a: Point, b: Point) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function ear(p1: Point, p2: Point, p3: Point, p4: Point, p5: Point, p6: Point) {
  const denom = 2 * dist(p1, p4);
  if (denom <= 1e-6) return 0;
  return (dist(p2, p6) + dist(p3, p5)) / denom;
}

function loadScriptOnce(src: string) {
  return new Promise<void>((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`) as HTMLScriptElement | null;
    if (existing) {
      if ((existing as any)._loaded) return resolve();
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error(`Failed to load ${src}`)), { once: true });
      return;
    }

    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => {
      (s as any)._loaded = true;
      resolve();
    };
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}

type UiState = {
  running: boolean;
  calibrating: boolean;
  blinks: number;
  blinksPerMin: number;
  secondsSinceBlink: number;
  alertOn: boolean;
  noBlinkThreshold: number;
  agreed: boolean;
  error: string | null;
  notifEnabled: boolean;
  notifPermission: "default" | "granted" | "denied";
  faceDetected: boolean;
};

type Action =
  | { type: "START" }
  | { type: "STOP" }
  | { type: "CALIBRATION_DONE" }
  | { type: "SET_BLINKS"; blinks: number }
  | { type: "SET_BPM"; bpm: number }
  | { type: "SET_SECONDS"; seconds: number }
  | { type: "ALERT_ON" }
  | { type: "ALERT_OFF" }
  | { type: "SET_THRESHOLD"; seconds: number }
  | { type: "AGREE" }
  | { type: "ERROR"; message: string }
  | { type: "CLEAR_ERROR" }
  | { type: "SET_NOTIF_ENABLED"; enabled: boolean }
  | { type: "SET_NOTIF_PERMISSION"; perm: "default" | "granted" | "denied" }
  | { type: "SET_FACE_DETECTED"; detected: boolean };

const initialState: UiState = {
  running: false,
  calibrating: false,
  blinks: 0,
  blinksPerMin: 0,
  secondsSinceBlink: 0,
  alertOn: false,
  noBlinkThreshold: 10,
  agreed: false,
  error: null,
  notifEnabled: true,
  notifPermission: "default",
  faceDetected: false,
};

function reducer(state: UiState, action: Action): UiState {
  switch (action.type) {
    case "START":
      return {
        ...initialState,
        running: true,
        calibrating: true,
        noBlinkThreshold: state.noBlinkThreshold,
        agreed: state.agreed,
        notifEnabled: state.notifEnabled,
        notifPermission: state.notifPermission,
      };

    case "STOP":
      return { ...state, running: false, calibrating: false, alertOn: false, faceDetected: false };

    case "CALIBRATION_DONE":
      return { ...state, calibrating: false, secondsSinceBlink: 0, alertOn: false };

    case "SET_BLINKS":
      return { ...state, blinks: action.blinks };

    case "SET_BPM":
      return { ...state, blinksPerMin: action.bpm };

    case "SET_SECONDS":
      return { ...state, secondsSinceBlink: action.seconds };

    case "ALERT_ON":
      return { ...state, alertOn: true };

    case "ALERT_OFF":
      return { ...state, alertOn: false };

    case "SET_THRESHOLD":
      return { ...state, noBlinkThreshold: action.seconds };

    case "AGREE":
      return { ...state, agreed: true };

    case "ERROR":
      return {
        ...state,
        error: action.message,
        running: false,
        calibrating: false,
        alertOn: false,
        faceDetected: false,
      };

    case "CLEAR_ERROR":
      return { ...state, error: null };

    case "SET_NOTIF_ENABLED":
      return { ...state, notifEnabled: action.enabled };

    case "SET_NOTIF_PERMISSION":
      return { ...state, notifPermission: action.perm };

    case "SET_FACE_DETECTED":
      return { ...state, faceDetected: action.detected };

    default:
      return state;
  }
}

function formatDuration(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

function gradeSession(args: {
  visibleMs: number;
  hiddenMs: number;
  totalMs: number;
  blinks: number;
  bpm: number;
  alerts: number;
  longestNoBlinkMs: number;
  riskyVisibleMs: number;
}) {
  const { visibleMs, totalMs, bpm, alerts, longestNoBlinkMs, riskyVisibleMs } = args;

  const visibilityPercent = totalMs > 0 ? (visibleMs / totalMs) * 100 : 0;
  const blinkCompliancePercent = visibleMs > 0 ? ((visibleMs - riskyVisibleMs) / visibleMs) * 100 : 0;
  const visibleMinutes = visibleMs / 60000;
  const longestNoBlinkSec = longestNoBlinkMs / 1000;

  let score = 100;
  const reasons: string[] = [];

  if (visibleMinutes < 0.5) {
    score -= 25;
    reasons.push("session too short");
  } else if (visibleMinutes < 1) {
    score -= 10;
    reasons.push("very short visible time");
  }

  if (bpm >= 15 && bpm <= 25) {
    // ideal range
  } else if ((bpm >= 10 && bpm < 15) || (bpm > 25 && bpm <= 30)) {
    score -= 10;
    reasons.push("blink rate slightly outside target range");
  } else if ((bpm >= 7 && bpm < 10) || (bpm > 30 && bpm <= 35)) {
    score -= 20;
    reasons.push("blink rate outside healthy target range");
  } else {
    score -= 35;
    reasons.push("blink rate far from target range");
  }

  if (alerts === 0) {
    // no penalty
  } else if (alerts <= 2) {
    score -= 8;
    reasons.push("a few no-blink alerts");
  } else if (alerts <= 5) {
    score -= 18;
    reasons.push("multiple no-blink alerts");
  } else {
    score -= 30;
    reasons.push("frequent no-blink alerts");
  }

  if (longestNoBlinkSec <= 10) {
    // no penalty
  } else if (longestNoBlinkSec <= 15) {
    score -= 8;
    reasons.push("one longer no-blink streak");
  } else if (longestNoBlinkSec <= 20) {
    score -= 15;
    reasons.push("long no-blink streak");
  } else {
    score -= 25;
    reasons.push("very long no-blink streak");
  }

  if (visibilityPercent < 60) {
    score -= 20;
    reasons.push("face not visible for much of session");
  } else if (visibilityPercent < 80) {
    score -= 8;
    reasons.push("face visibility could be more consistent");
  }

  if (blinkCompliancePercent < 70) {
    score -= 18;
    reasons.push("too much time spent above the no-blink threshold");
  } else if (blinkCompliancePercent < 85) {
    score -= 8;
    reasons.push("some extended no-blink periods");
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  let grade = "F";
  if (score >= 90) grade = "A";
  else if (score >= 80) grade = "B";
  else if (score >= 70) grade = "C";
  else if (score >= 60) grade = "D";

  const gradeReason =
    reasons.length > 0
      ? reasons.join(", ")
      : "steady blinking, good face visibility, and no alert issues";

  return {
    score,
    grade,
    gradeReason,
    visibilityPercent,
    blinkCompliancePercent,
  };
}

export default function Page() {
  const [mounted, setMounted] = useState(false);
  const [sessionSummary, setSessionSummary] = useState<SessionSummary | null>(null);

  useEffect(() => setMounted(true), []);

  const [state, dispatch] = useReducer(reducer, initialState);
  const {
    running,
    calibrating,
    blinks,
    blinksPerMin,
    secondsSinceBlink,
    alertOn,
    noBlinkThreshold,
    agreed,
    error,
    notifEnabled,
    notifPermission,
    faceDetected,
  } = state;

  const videoRef = useRef<HTMLVideoElement>(null);
  const hiddenCanvasRef = useRef<HTMLCanvasElement>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);
  const meshRef = useRef<any>(null);
  const activeRef = useRef(false);
  const startingRef = useRef(false);
  const faceDetectedRef = useRef(false);
  const faceMissingSinceRef = useRef<number | null>(null);

  const baselineEarRef = useRef<number | null>(null);
  const calibStartRef = useRef<number | null>(null);
  const maxEarRef = useRef(0);
  const openSamplesRef = useRef<number[]>([]);

  const eyeStateRef = useRef<"OPEN" | "CLOSED">("OPEN");
  const closedFramesRef = useRef(0);
  const lastBlinkMsRef = useRef(0);

  const lastBlinkVisibleTotalMsRef = useRef<number | null>(null);
  const lastAlertAtRef = useRef(0);

  const sessionStartRef = useRef<number | null>(null);
  const blinkCountRef = useRef(0);
  const totalVisibleTimeMsRef = useRef(0);
  const totalHiddenTimeMsRef = useRef(0);
  const visibleSegmentStartRef = useRef<number | null>(null);
  const hiddenSegmentStartRef = useRef<number | null>(null);

  const alertCountRef = useRef(0);
  const longestNoBlinkMsRef = useRef(0);
  const riskyVisibleTimeMsRef = useRef(0);
  const lastTimerTickMsRef = useRef<number | null>(null);

  const audioCtxRef = useRef<AudioContext | null>(null);

  const lastNotifAtRef = useRef(0);
  const lastAlertOnRef = useRef(false);
  const NOTIF_COOLDOWN_MS = 5000;

  const CALIBRATION_MS = 3000;
  const CLOSE_RATIO = 0.62;
  const OPEN_RATIO = 0.82;
  const MIN_CLOSED_FRAMES = 2;
  const MIN_BLINK_GAP_MS = 350;
  const FACE_LOST_DEBOUNCE_MS = 300;
  const ALERT_REPEAT_MS = 2000;
  const BPM_UPDATE_MS = 400;

  const lastBpmUpdateRef = useRef(0);

  function getVisibleTotalMs(now: number) {
    return (
      totalVisibleTimeMsRef.current +
      (visibleSegmentStartRef.current !== null ? now - visibleSegmentStartRef.current : 0)
    );
  }

  function updateFaceVisibility(isFaceVisible: boolean, now: number) {
    if (isFaceVisible === faceDetectedRef.current) return;

    if (isFaceVisible) {
      if (hiddenSegmentStartRef.current !== null) {
        totalHiddenTimeMsRef.current += Math.max(0, now - hiddenSegmentStartRef.current);
        hiddenSegmentStartRef.current = null;
      }
      visibleSegmentStartRef.current = now;
    } else {
      if (visibleSegmentStartRef.current !== null) {
        totalVisibleTimeMsRef.current += Math.max(0, now - visibleSegmentStartRef.current);
        visibleSegmentStartRef.current = null;
      }
      hiddenSegmentStartRef.current = now;
    }

    faceDetectedRef.current = isFaceVisible;
    dispatch({ type: "SET_FACE_DETECTED", detected: isFaceVisible });
  }

  function finalizeTiming(now: number) {
    if (visibleSegmentStartRef.current !== null) {
      totalVisibleTimeMsRef.current += Math.max(0, now - visibleSegmentStartRef.current);
      visibleSegmentStartRef.current = null;
    }

    if (hiddenSegmentStartRef.current !== null) {
      totalHiddenTimeMsRef.current += Math.max(0, now - hiddenSegmentStartRef.current);
      hiddenSegmentStartRef.current = null;
    }
  }

  useEffect(() => {
    if (!mounted) return;

    try {
      const savedThreshold = localStorage.getItem("noBlinkThreshold");
      if (savedThreshold) {
        const n = Number(savedThreshold);
        if (Number.isFinite(n) && n > 0) {
          dispatch({ type: "SET_THRESHOLD", seconds: n });
        }
      }

      const savedNotif = localStorage.getItem("notifEnabled");
      if (savedNotif !== null) {
        dispatch({ type: "SET_NOTIF_ENABLED", enabled: savedNotif === "true" });
      }
    } catch {
      // ignore
    }
  }, [mounted]);

  function beep() {
    const AudioCtx =
      (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext | undefined;
    if (!AudioCtx) return;

    if (!audioCtxRef.current) audioCtxRef.current = new AudioCtx();
    const ctx = audioCtxRef.current;

    if (ctx.state === "suspended") ctx.resume().catch(() => {});

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.value = 0.06;

    osc.connect(gain);
    gain.connect(ctx.destination);

    const t0 = ctx.currentTime;
    osc.start(t0);
    osc.stop(t0 + 0.18);

    osc.onended = () => {
      try {
        osc.disconnect();
        gain.disconnect();
      } catch {}
    };
  }

  async function requestNotifPermission() {
    if (!mounted) return;
    if (!("Notification" in window)) return;

    try {
      const perm = await Notification.requestPermission();
      dispatch({ type: "SET_NOTIF_PERMISSION", perm });

      if (perm === "granted") {
        try {
          new Notification("Notifications enabled", {
            body: "You’ll get an alert when you stop blinking.",
          });
        } catch {}
      }
    } catch {
      // ignore
    }
  }

  function showAlertNotification() {
    if (!notifEnabled) return;
    if (!mounted) return;
    if (!("Notification" in window)) return;
    if (Notification.permission !== "granted") return;

    const now = Date.now();
    if (now - lastNotifAtRef.current < NOTIF_COOLDOWN_MS) return;
    lastNotifAtRef.current = now;

    try {
      new Notification("Blink reminder", {
        body: "No blink detected — please blink.",
      });
    } catch {}
  }

  function setNoBlinkAlert(seconds: number) {
    dispatch({ type: "SET_THRESHOLD", seconds });

    if (mounted) {
      try {
        localStorage.setItem("noBlinkThreshold", String(seconds));
      } catch {}
    }
  }

  function resetRefs() {
    baselineEarRef.current = null;
    calibStartRef.current = null;
    maxEarRef.current = 0;
    openSamplesRef.current = [];

    eyeStateRef.current = "OPEN";
    closedFramesRef.current = 0;
    lastBlinkMsRef.current = 0;

    lastBlinkVisibleTotalMsRef.current = null;
    lastAlertAtRef.current = 0;

    sessionStartRef.current = null;
    blinkCountRef.current = 0;
    totalVisibleTimeMsRef.current = 0;
    totalHiddenTimeMsRef.current = 0;
    visibleSegmentStartRef.current = null;
    hiddenSegmentStartRef.current = null;

    alertCountRef.current = 0;
    longestNoBlinkMsRef.current = 0;
    riskyVisibleTimeMsRef.current = 0;
    lastTimerTickMsRef.current = null;

    lastBpmUpdateRef.current = 0;

    lastNotifAtRef.current = 0;
    lastAlertOnRef.current = false;
    faceDetectedRef.current = false;
    faceMissingSinceRef.current = null;
    dispatch({ type: "SET_FACE_DETECTED", detected: false });
    dispatch({ type: "SET_SECONDS", seconds: 0 });
  }

  function cleanupLoopsAndStream() {
    activeRef.current = false;

    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;

    if (timerRef.current) window.clearInterval(timerRef.current);
    timerRef.current = null;

    if (streamRef.current) {
      for (const t of streamRef.current.getTracks()) t.stop();
      streamRef.current = null;
    }

    if (meshRef.current) {
      try {
        meshRef.current.close();
      } catch {}
      meshRef.current = null;
    }
  }

  async function start() {
    if (!agreed || running || startingRef.current) return;
    startingRef.current = true;

    dispatch({ type: "CLEAR_ERROR" });
    resetRefs();
    setSessionSummary(null);
    dispatch({ type: "START" });
    activeRef.current = true;

    try {
      await loadScriptOnce("https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/face_mesh.js");

      const startNow = performance.now();
      sessionStartRef.current = startNow;
      hiddenSegmentStartRef.current = startNow;

      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      streamRef.current = stream;

      const video = videoRef.current;
      const canvas = hiddenCanvasRef.current;
      if (!video || !canvas) throw new Error("Video/canvas not ready.");

      video.srcObject = stream;
      await video.play();

      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Failed to get canvas 2D context.");

      const FaceMesh = window.FaceMesh;
      if (!FaceMesh) throw new Error("FaceMesh failed to load (window.FaceMesh missing).");

      const mesh = new FaceMesh({
        locateFile: (f: string) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${f}`,
      });
      meshRef.current = mesh;

      mesh.setOptions({
        maxNumFaces: 1,
        refineLandmarks: true,
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });

      mesh.onResults((res: any) => {
        if (!activeRef.current) return;

        const now = performance.now();
        const hasFace = !!res.multiFaceLandmarks?.length;

        if (hasFace) {
          faceMissingSinceRef.current = null;

          if (!faceDetectedRef.current) {
            updateFaceVisibility(true, now);
          }
        } else {
          if (faceMissingSinceRef.current === null) {
            faceMissingSinceRef.current = now;
          }

          if (now - faceMissingSinceRef.current >= FACE_LOST_DEBOUNCE_MS) {
            if (faceDetectedRef.current) {
              updateFaceVisibility(false, now);
            }
          }
        }

        if (!hasFace) return;

        const lm = res.multiFaceLandmarks[0] as Point[];

        const L = { p1: 33, p2: 160, p3: 159, p4: 133, p5: 145, p6: 144 };
        const R = { p1: 362, p2: 387, p3: 386, p4: 263, p5: 374, p6: 373 };

        const left = ear(lm[L.p1], lm[L.p2], lm[L.p3], lm[L.p4], lm[L.p5], lm[L.p6]);
        const right = ear(lm[R.p1], lm[R.p2], lm[R.p3], lm[R.p4], lm[R.p5], lm[R.p6]);
        const curEar = (left + right) / 2;

        if (baselineEarRef.current === null) {
          if (calibStartRef.current === null) calibStartRef.current = now;

          maxEarRef.current = Math.max(maxEarRef.current, curEar);
          if (curEar > maxEarRef.current * 0.8) openSamplesRef.current.push(curEar);

          if (now - (calibStartRef.current ?? now) >= CALIBRATION_MS) {
            const samples = openSamplesRef.current;
            baselineEarRef.current =
              samples.length > 0 ? samples.reduce((a, b) => a + b, 0) / samples.length : maxEarRef.current;

            lastBlinkVisibleTotalMsRef.current = getVisibleTotalMs(now);
            dispatch({ type: "CALIBRATION_DONE" });
            dispatch({ type: "SET_SECONDS", seconds: 0 });
            dispatch({ type: "ALERT_OFF" });
          }
          return;
        }

        const baseline = baselineEarRef.current;
        const closeThr = baseline * CLOSE_RATIO;
        const openThr = baseline * OPEN_RATIO;

        if (eyeStateRef.current === "OPEN") {
          if (curEar < closeThr) {
            closedFramesRef.current = 1;
            eyeStateRef.current = "CLOSED";
          }
        } else {
          if (curEar < closeThr) closedFramesRef.current += 1;

          if (curEar > openThr) {
            const longEnough = closedFramesRef.current >= MIN_CLOSED_FRAMES;
            const farEnough = now - lastBlinkMsRef.current >= MIN_BLINK_GAP_MS;

            if (longEnough && farEnough) {
              blinkCountRef.current += 1;
              dispatch({ type: "SET_BLINKS", blinks: blinkCountRef.current });
              lastBlinkMsRef.current = now;
              lastBlinkVisibleTotalMsRef.current = getVisibleTotalMs(now);
              dispatch({ type: "SET_SECONDS", seconds: 0 });
              dispatch({ type: "ALERT_OFF" });
            }

            eyeStateRef.current = "OPEN";
            closedFramesRef.current = 0;
          }
        }

        const visibleMinutes = getVisibleTotalMs(now) / 60000;
        const bpm = visibleMinutes > 0 ? blinkCountRef.current / visibleMinutes : 0;

        if (now - lastBpmUpdateRef.current >= BPM_UPDATE_MS) {
          lastBpmUpdateRef.current = now;
          dispatch({ type: "SET_BPM", bpm });
        }
      });

      const loop = async () => {
        if (!activeRef.current) return;

        const v = videoRef.current;
        const c = hiddenCanvasRef.current;
        if (!v || !c) return;

        if (v.readyState === 4) {
          c.width = v.videoWidth;
          c.height = v.videoHeight;
          ctx.drawImage(v, 0, 0, c.width, c.height);

          if (activeRef.current) {
            await mesh.send({ image: c });
          }
        }

        if (activeRef.current) {
          rafRef.current = requestAnimationFrame(loop);
        }
      };
      rafRef.current = requestAnimationFrame(loop);

      timerRef.current = window.setInterval(() => {
        if (!baselineEarRef.current) return;

        const now = performance.now();
        const lastTick = lastTimerTickMsRef.current ?? now;
        const deltaMs = Math.max(0, now - lastTick);
        lastTimerTickMsRef.current = now;

        const lastBlinkVisible = lastBlinkVisibleTotalMsRef.current;
        const visibleElapsedMs =
          lastBlinkVisible === null ? 0 : Math.max(0, getVisibleTotalMs(now) - lastBlinkVisible);
        const sec = visibleElapsedMs / 1000;

        if (visibleElapsedMs > longestNoBlinkMsRef.current) {
          longestNoBlinkMsRef.current = visibleElapsedMs;
        }

        dispatch({ type: "SET_SECONDS", seconds: sec });

        if (!faceDetectedRef.current) {
          dispatch({ type: "ALERT_OFF" });
          lastAlertOnRef.current = false;
          return;
        }

        if (sec >= noBlinkThreshold) {
          riskyVisibleTimeMsRef.current += deltaMs;
          dispatch({ type: "ALERT_ON" });

          if (!lastAlertOnRef.current) {
            lastAlertOnRef.current = true;
            alertCountRef.current += 1;
            showAlertNotification();
          } else {
            showAlertNotification();
          }

          if (now - lastAlertAtRef.current >= ALERT_REPEAT_MS) {
            lastAlertAtRef.current = now;
            beep();
          }
        } else {
          dispatch({ type: "ALERT_OFF" });
          lastAlertOnRef.current = false;
        }
      }, 100);
    } catch (e: any) {
      cleanupLoopsAndStream();
      dispatch({ type: "ERROR", message: e?.message ?? "Failed to start." });
    } finally {
      startingRef.current = false;
    }
  }

  function stop() {
    const now = performance.now();
    finalizeTiming(now);

    const totalVisible = totalVisibleTimeMsRef.current;
    const totalHidden = totalHiddenTimeMsRef.current;
    const totalSessionTime =
      sessionStartRef.current !== null ? Math.max(0, now - sessionStartRef.current) : totalVisible + totalHidden;
    const averageBlinksPerMinute = totalVisible > 0 ? blinkCountRef.current / (totalVisible / 60000) : 0;

    const grading = gradeSession({
      visibleMs: totalVisible,
      hiddenMs: totalHidden,
      totalMs: totalSessionTime,
      blinks: blinkCountRef.current,
      bpm: averageBlinksPerMinute,
      alerts: alertCountRef.current,
      longestNoBlinkMs: longestNoBlinkMsRef.current,
      riskyVisibleMs: riskyVisibleTimeMsRef.current,
    });

    const summary: SessionSummary = {
      totalBlinks: blinkCountRef.current,
      totalVisibleTimeMs: totalVisible,
      totalHiddenTimeMs: totalHidden,
      totalSessionTimeMs: totalSessionTime,
      averageBlinksPerMinute,

      totalAlerts: alertCountRef.current,
      longestNoBlinkMs: longestNoBlinkMsRef.current,
      visibilityPercent: grading.visibilityPercent,
      blinkCompliancePercent: grading.blinkCompliancePercent,

      score: grading.score,
      grade: grading.grade,
      gradeReason: grading.gradeReason,
    };

    setSessionSummary(summary);
    dispatch({ type: "STOP" });
    cleanupLoopsAndStream();

    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
  }

  useEffect(() => {
    if (!mounted) return;
    if (!("Notification" in window)) return;
    dispatch({ type: "SET_NOTIF_PERMISSION", perm: Notification.permission });
  }, [mounted]);

  useEffect(() => {
    const onVis = () => {
      if (document.hidden && running) stop();
    };

    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [running]);

  useEffect(() => {
    return () => {
      cleanupLoopsAndStream();

      if (audioCtxRef.current) {
        audioCtxRef.current.close().catch(() => {});
        audioCtxRef.current = null;
      }
    };
  }, []);

  const statusText = error
    ? `Error: ${error}`
    : !running
      ? "Press Start to begin."
      : calibrating
        ? "Calibrating… keep your eyes open for a few seconds."
        : !faceDetected
          ? "No face detected — alarm paused."
          : alertOn
            ? "BLINK! (alert repeats until you blink)"
            : "Monitoring…";

  const canUseNotifications = mounted && "Notification" in window;

  return (
    <div style={{ background: "#000", color: "#fff", minHeight: "100vh", padding: 20 }}>
      <h1 style={{ margin: 0 }}>Blink Monitor (Webcam)</h1>

      {running && !calibrating && alertOn && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.72)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
            padding: 16,
          }}
        >
          <div
            style={{
              width: "min(520px, 100%)",
              background: "#111",
              border: "2px solid #ff4d4d",
              borderRadius: 14,
              padding: 18,
              boxShadow: "0 0 0 1px rgba(255,77,77,0.25)",
            }}
          >
            <div style={{ fontSize: 22, fontWeight: 700, color: "#ff4d4d" }}>Blink now</div>
            <div style={{ marginTop: 8, lineHeight: 1.5, opacity: 0.95 }}>
              No blink detected for <b>{secondsSinceBlink.toFixed(1)}s</b>. Please blink to clear the alarm.
            </div>

            <div
              style={{
                marginTop: 12,
                padding: "10px 12px",
                borderRadius: 10,
                background: "#0b0b0b",
                border: "1px solid #222",
                opacity: 0.95,
              }}
            >
              Alarm threshold: <b>{noBlinkThreshold}s</b> • Beep repeats every{" "}
              <b>{(ALERT_REPEAT_MS / 1000).toFixed(1)}s</b>
            </div>

            <div style={{ marginTop: 14, fontSize: 13, opacity: 0.75 }}>
              Tip: The alarm stops automatically after you blink.
            </div>
          </div>
        </div>
      )}

      {!agreed && (
        <div
          style={{
            maxWidth: 640,
            background: "#111",
            border: "1px solid #333",
            borderRadius: 10,
            padding: 16,
            marginTop: 16,
            lineHeight: 1.6,
          }}
        >
          <h3 style={{ marginTop: 0, color: "#ffcc66" }}>Research Disclaimer</h3>

          <p>This is a research prototype and not a medical device. The results are experimental and may not be accurate.</p>

          <p>
            If you have eye pain, discomfort, or vision issues, please stop using this tool and contact a qualified medical
            professional.
          </p>

          <p style={{ fontSize: 14, opacity: 0.8 }}>
            By clicking “I agree”, you acknowledge that you understand these limitations.
          </p>

          <button
            onClick={() => {
              requestNotifPermission();
              dispatch({ type: "AGREE" });
            }}
            style={{ marginTop: 10, padding: "8px 14px", cursor: "pointer" }}
          >
            I agree
          </button>
        </div>
      )}

      <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 16, flexWrap: "wrap" }}>
        <button
          onClick={() => {
            if (running) {
              stop();
            } else {
              void start();
            }
          }}
          style={{ padding: "8px 14px", cursor: agreed ? "pointer" : "not-allowed", opacity: agreed ? 1 : 0.5 }}
          disabled={!agreed}
        >
          {running ? "Stop" : "Start"}
        </button>

        <div
          style={{
            padding: "6px 10px",
            borderRadius: 8,
            background: alertOn ? "#3b0a0a" : "#111",
            border: `1px solid ${alertOn ? "#ff4d4d" : "#222"}`,
          }}
        >
          <b>Status:</b> {statusText}
        </div>

        <div style={{ marginLeft: 8 }}>
          <label style={{ opacity: 0.9 }}>
            Alert if no blink for{" "}
            <select
              value={noBlinkThreshold}
              onChange={(e) => setNoBlinkAlert(Number(e.target.value))}
              style={{ marginLeft: 8, padding: "4px 6px" }}
              disabled={running}
            >
              <option value={5}>5 sec</option>
              <option value={8}>8 sec</option>
              <option value={10}>10 sec (default)</option>
              <option value={12}>12 sec</option>
              <option value={15}>15 sec</option>
            </select>
          </label>
        </div>

        <div style={{ marginLeft: 8 }}>
          <label style={{ opacity: 0.9 }}>
            <input
              type="checkbox"
              checked={notifEnabled}
              onChange={(e) => {
                const enabled = e.target.checked;
                dispatch({ type: "SET_NOTIF_ENABLED", enabled });

                if (mounted) {
                  try {
                    localStorage.setItem("notifEnabled", String(enabled));
                  } catch {}
                }
              }}
              disabled={!canUseNotifications}
              style={{ marginRight: 8 }}
            />
            Desktop notification on alarm
          </label>

          {canUseNotifications && notifEnabled && notifPermission !== "granted" && (
            <button
              onClick={requestNotifPermission}
              style={{ marginLeft: 10, padding: "6px 10px", cursor: "pointer" }}
            >
              Enable notifications
            </button>
          )}

          {!canUseNotifications && (
            <span style={{ marginLeft: 10, fontSize: 12, opacity: 0.7 }}>
              (Notifications not supported in this browser)
            </span>
          )}

          {canUseNotifications && notifPermission === "denied" && (
            <span style={{ marginLeft: 10, fontSize: 12, color: "#ffcc66" }}>
              (Permission denied in browser settings)
            </span>
          )}
        </div>
      </div>

      <div style={{ marginTop: 16, display: "flex", justifyContent: "center" }}>
        {sessionSummary && !running ? (
          <div
            style={{
              width: "min(700px, 100%)",
              minHeight: 480,
              background: "#111",
              border: "1px solid #333",
              borderRadius: 14,
              padding: 24,
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
            }}
          >
            <div style={{ fontSize: 24, fontWeight: 700, marginBottom: 16 }}>Session Summary</div>

            <div style={{ lineHeight: 1.9, fontSize: 17 }}>
              <div>
                <b>Total blinks:</b> {sessionSummary.totalBlinks}
              </div>
              <div>
                <b>Total alerts:</b> {sessionSummary.totalAlerts}
              </div>
              <div>
                <b>Total visible time:</b> {formatDuration(sessionSummary.totalVisibleTimeMs)}
              </div>
              <div>
                <b>Total hidden time:</b> {formatDuration(sessionSummary.totalHiddenTimeMs)}
              </div>
              <div>
                <b>Total session time:</b> {formatDuration(sessionSummary.totalSessionTimeMs)}
              </div>
              <div>
                <b>Average blinks / min:</b> {sessionSummary.averageBlinksPerMinute.toFixed(1)}
              </div>
              <div>
                <b>Longest no-blink streak:</b> {formatDuration(sessionSummary.longestNoBlinkMs)}
              </div>
              <div>
                <b>Face visibility:</b> {sessionSummary.visibilityPercent.toFixed(1)}%
              </div>
              <div>
                <b>Blink compliance:</b> {sessionSummary.blinkCompliancePercent.toFixed(1)}%
              </div>
              <div>
                <b>Session score:</b> {sessionSummary.score}/100
              </div>
              <div>
                <b>Grade:</b> {sessionSummary.grade}
              </div>
              <div>
                <b>Why:</b> {sessionSummary.gradeReason}
              </div>
            </div>

            <div style={{ display: "flex", gap: 10, marginTop: 20, flexWrap: "wrap" }}>
              <button
                onClick={() => {
                  setSessionSummary(null);
                }}
                style={{ padding: "10px 16px", cursor: "pointer" }}
              >
                Close Summary
              </button>

              <button
                onClick={() => {
                  setSessionSummary(null);
                  void start();
                }}
                style={{ padding: "10px 16px", cursor: "pointer" }}
              >
                Start New Session
              </button>
            </div>
          </div>
        ) : running ? (
          <div>
            <video
              ref={videoRef}
              muted
              playsInline
              width={640}
              height={480}
              style={{ borderRadius: 10, background: "#111" }}
            />
            <canvas ref={hiddenCanvasRef} style={{ display: "none" }} />
          </div>
        ) : (
          <div
            style={{
              width: "min(640px, 100%)",
              minHeight: 480,
              borderRadius: 10,
              background: "#111",
              border: "1px solid #222",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              opacity: 0.8,
            }}
          >
            Press Start to begin a new session.
          </div>
        )}
      </div>

      <div style={{ marginTop: 14, lineHeight: 1.7 }}>
        <div>
          <b>Blinks:</b> {blinks}
        </div>
        <div>
          <b>Blinks / min:</b> {blinksPerMin.toFixed(1)}
        </div>
        <div>
          <b>Seconds since last blink:</b> {secondsSinceBlink.toFixed(1)}
        </div>
        <div style={{ opacity: 0.75 }}>Tip: if you don’t hear sound, click once on the page (browser audio rule).</div>
      </div>
    </div>
  );
}
