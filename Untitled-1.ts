"use client";

import { useEffect, useReducer, useRef, useState } from "react";

declare global {
  interface Window {
    FaceMesh?: any;
  }
}
export {};

type Point = { x: number; y: number };

function dist(a: Point, b: Point) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Eye Aspect Ratio (EAR)
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

/* -------------------- Reducer -------------------- */

type UiState = {
  running: boolean;
  calibrating: boolean;
  blinks: number;
  blinksPerMin: number;
  secondsSinceBlink: number;
  alertOn: boolean;
  noBlinkThreshold: number; // seconds
  agreed: boolean; // user consent
  error: string | null;

  // Notifications
  notifEnabled: boolean;
  notifPermission: "default" | "granted" | "denied";
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
  | { type: "SET_NOTIF_PERMISSION"; perm: "default" | "granted" | "denied" };

const initialState: UiState = {
  running: false,
  calibrating: false,
  blinks: 0,
  blinksPerMin: 0,
  secondsSinceBlink: 0,
  alertOn: false,
  noBlinkThreshold: 10, // default = 10 sec
  agreed: false,
  error: null,

  notifEnabled: true,
  notifPermission: "default",
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
      return { ...state, running: false, calibrating: false, alertOn: false };

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
      return { ...state, error: action.message, running: false, calibrating: false, alertOn: false };

    case "CLEAR_ERROR":
      return { ...state, error: null };

    case "SET_NOTIF_ENABLED":
      return { ...state, notifEnabled: action.enabled };

    case "SET_NOTIF_PERMISSION":
      return { ...state, notifPermission: action.perm };

    default:
      return state;
  }
}

export default function Page() {
  // ✅ prevent hydration mismatch for Notification/window-dependent UI
  const [mounted, setMounted] = useState(false);
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
  } = state;

  const videoRef = useRef<HTMLVideoElement>(null);
  const hiddenCanvasRef = useRef<HTMLCanvasElement>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);

  // Calibration
  const baselineEarRef = useRef<number | null>(null);
  const calibStartRef = useRef<number | null>(null);
  const maxEarRef = useRef(0);
  const openSamplesRef = useRef<number[]>([]);

  // Blink detection
  const eyeStateRef = useRef<"OPEN" | "CLOSED">("OPEN");
  const closedFramesRef = useRef(0);
  const lastBlinkMsRef = useRef(0);

  // Monitoring
  const lastBlinkAtRef = useRef<number | null>(null);
  const lastAlertAtRef = useRef(0);

  // Stats
  const sessionStartRef = useRef<number | null>(null);
  const blinkCountRef = useRef(0);

  // Audio (reuse one context)
  const audioCtxRef = useRef<AudioContext | null>(null);

  // Notifications
  const lastNotifAtRef = useRef(0);
  const lastAlertOnRef = useRef(false);
  const NOTIF_COOLDOWN_MS = 5000;

  // Tunables
  const CALIBRATION_MS = 3000;
  const CLOSE_RATIO = 0.62;
  const OPEN_RATIO = 0.82;
  const MIN_CLOSED_FRAMES = 2;
  const MIN_BLINK_GAP_MS = 350;

  // Repeat beep while danger continues (until blink)
  const ALERT_REPEAT_MS = 2000;

  // Reduce re-render spam: update BPM at most every 400ms
  const lastBpmUpdateRef = useRef(0);
  const BPM_UPDATE_MS = 400;

  function beep() {
    const AudioCtx =
      (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext | undefined;
    if (!AudioCtx) return;

    if (!audioCtxRef.current) {
      audioCtxRef.current = new AudioCtx();
    }
    const ctx = audioCtxRef.current;

    if (ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }

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
    } catch {
      // ignore
    }
  }

  function setNoBlinkAlert(seconds: number) {
    dispatch({ type: "SET_THRESHOLD", seconds });
  }

  function resetRefs() {
    baselineEarRef.current = null;
    calibStartRef.current = null;
    maxEarRef.current = 0;
    openSamplesRef.current = [];

    eyeStateRef.current = "OPEN";
    closedFramesRef.current = 0;
    lastBlinkMsRef.current = 0;

    lastBlinkAtRef.current = null;
    lastAlertAtRef.current = 0;

    sessionStartRef.current = null;
    blinkCountRef.current = 0;

    lastBpmUpdateRef.current = 0;

    lastNotifAtRef.current = 0;
    lastAlertOnRef.current = false;
  }

  function cleanupLoopsAndStream() {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;

    if (timerRef.current) window.clearInterval(timerRef.current);
    timerRef.current = null;

    if (streamRef.current) {
      for (const t of streamRef.current.getTracks()) t.stop();
      streamRef.current = null;
    }
  }

  async function start() {
    if (!agreed) return;

    dispatch({ type: "CLEAR_ERROR" });
    resetRefs();
    dispatch({ type: "START" });

    try {
      await loadScriptOnce("https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/face_mesh.js");

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

      mesh.setOptions({
        maxNumFaces: 1,
        refineLandmarks: true,
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });

      mesh.onResults((res: any) => {
        if (!res.multiFaceLandmarks?.length) return;

        const lm = res.multiFaceLandmarks[0] as Point[];
        const now = performance.now();

        // Eye landmarks for EAR
        const L = { p1: 33, p2: 160, p3: 159, p4: 133, p5: 145, p6: 144 };
        const R = { p1: 362, p2: 387, p3: 386, p4: 263, p5: 374, p6: 373 };

        const left = ear(lm[L.p1], lm[L.p2], lm[L.p3], lm[L.p4], lm[L.p5], lm[L.p6]);
        const right = ear(lm[R.p1], lm[R.p2], lm[R.p3], lm[R.p4], lm[R.p5], lm[R.p6]);
        const curEar = (left + right) / 2;

        // Calibration (collect open-eye samples)
        if (baselineEarRef.current === null) {
          if (calibStartRef.current === null) calibStartRef.current = now;

          maxEarRef.current = Math.max(maxEarRef.current, curEar);
          if (curEar > maxEarRef.current * 0.8) openSamplesRef.current.push(curEar);

          if (now - (calibStartRef.current ?? now) >= CALIBRATION_MS) {
            const samples = openSamplesRef.current;
            baselineEarRef.current =
              samples.length > 0 ? samples.reduce((a, b) => a + b, 0) / samples.length : maxEarRef.current;

            dispatch({ type: "CALIBRATION_DONE" });

            lastBlinkAtRef.current = now;
            dispatch({ type: "SET_SECONDS", seconds: 0 });
            dispatch({ type: "ALERT_OFF" });
          }
          return;
        }

        // Blink thresholds
        const baseline = baselineEarRef.current;
        const closeThr = baseline * CLOSE_RATIO;
        const openThr = baseline * OPEN_RATIO;

        // Blink detection state machine
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

              // Blink resets timer + alert
              lastBlinkAtRef.current = now;
              dispatch({ type: "SET_SECONDS", seconds: 0 });
              dispatch({ type: "ALERT_OFF" });
            }

            eyeStateRef.current = "OPEN";
            closedFramesRef.current = 0;
          }
        }

        // Blinks/min (rate-limited to reduce re-renders)
        if (sessionStartRef.current === null) sessionStartRef.current = now;
        const minutes = (now - sessionStartRef.current) / 60000;
        const bpm = minutes > 0 ? blinkCountRef.current / minutes : 0;

        if (now - lastBpmUpdateRef.current >= BPM_UPDATE_MS) {
          lastBpmUpdateRef.current = now;
          dispatch({ type: "SET_BPM", bpm });
        }
      });

      // FaceMesh loop
      const loop = async () => {
        const v = videoRef.current;
        const c = hiddenCanvasRef.current;
        if (!v || !c) return;

        if (v.readyState === 4) {
          c.width = v.videoWidth;
          c.height = v.videoHeight;
          ctx.drawImage(v, 0, 0, c.width, c.height);
          await mesh.send({ image: c });
        }

        rafRef.current = requestAnimationFrame(loop);
      };
      rafRef.current = requestAnimationFrame(loop);

      // Background monitor loop
      timerRef.current = window.setInterval(() => {
        if (!baselineEarRef.current) return; // calibration not finished yet

        const now = performance.now();
        const last = lastBlinkAtRef.current ?? now;
        const sec = Math.max(0, (now - last) / 1000);

        dispatch({ type: "SET_SECONDS", seconds: sec });

        if (sec >= noBlinkThreshold) {
          dispatch({ type: "ALERT_ON" });

          // fire notification on transition to alert (and cooldown)
          if (!lastAlertOnRef.current) {
            lastAlertOnRef.current = true;
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
    }
  }

  function stop() {
    dispatch({ type: "STOP" });
    cleanupLoopsAndStream();

    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
  }

  // Keep notif permission in UI state
  useEffect(() => {
    if (!mounted) return;
    if (!("Notification" in window)) return;
    dispatch({ type: "SET_NOTIF_PERMISSION", perm: Notification.permission });
  }, [mounted]);

  // Pause when tab is hidden
  useEffect(() => {
    const onVis = () => {
      if (document.hidden && running) stop();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  useEffect(() => {
    return () => stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const statusText = error
    ? `Error: ${error}`
    : !running
      ? "Press Start to begin."
      : calibrating
        ? "Calibrating… keep your eyes open for a few seconds."
        : alertOn
          ? "BLINK! (alert repeats until you blink)"
          : "Monitoring…";

  const canUseNotifications = mounted && "Notification" in window;

  return (
    <div style={{ background: "#000", color: "#fff", minHeight: "100vh", padding: 20 }}>
      <h1 style={{ margin: 0 }}>Blink Monitor (Webcam)</h1>

      {/* POPUP OVERLAY when alarm is on */}
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

          <button onClick={() => dispatch({ type: "AGREE" })} style={{ marginTop: 10, padding: "8px 14px", cursor: "pointer" }}>
            I agree
          </button>
        </div>
      )}

      <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 16, flexWrap: "wrap" }}>
        <button
          onClick={() => (running ? stop() : start())}
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

        {/* Notification controls */}
        <div style={{ marginLeft: 8 }}>
          <label style={{ opacity: 0.9 }}>
            <input
              type="checkbox"
              checked={notifEnabled}
              onChange={(e) => dispatch({ type: "SET_NOTIF_ENABLED", enabled: e.target.checked })}
              disabled={!canUseNotifications}
              style={{ marginRight: 8 }}
            />
            Desktop notification on alarm
          </label>

          {canUseNotifications && notifEnabled && notifPermission !== "granted" && (
            <button onClick={requestNotifPermission} style={{ marginLeft: 10, padding: "6px 10px", cursor: "pointer" }}>
              Enable notifications
            </button>
          )}

          {!canUseNotifications && (
            <span style={{ marginLeft: 10, fontSize: 12, opacity: 0.7 }}>(Notifications not supported in this browser)</span>
          )}

          {canUseNotifications && notifPermission === "denied" && (
            <span style={{ marginLeft: 10, fontSize: 12, color: "#ffcc66" }}>(Permission denied in browser settings)</span>
          )}
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <video ref={videoRef} muted playsInline width={640} height={480} style={{ borderRadius: 10, background: "#111" }} />
        <canvas ref={hiddenCanvasRef} style={{ display: "none" }} />
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