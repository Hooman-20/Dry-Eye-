"use client";

import { useEffect, useReducer, useRef, useState } from "react";

import { addDoc, collection, doc, updateDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";

type Point = { x: number; y: number };

type LoadableScriptElement = HTMLScriptElement & { _loaded?: boolean };

type FaceMeshResults = {
  multiFaceLandmarks?: Point[][];
};

type FaceMeshInstance = {
  setOptions: (options: {
    maxNumFaces: number;
    refineLandmarks: boolean;
    minDetectionConfidence: number;
    minTrackingConfidence: number;
  }) => void;
  onResults: (callback: (results: FaceMeshResults) => void) => void;
  send: (input: { image: HTMLCanvasElement }) => Promise<void>;
  close: () => void;
};

type FaceMeshConstructor = new (options: {
  locateFile: (file: string) => string;
}) => FaceMeshInstance;

declare global {
  interface Window {
    FaceMesh?: FaceMeshConstructor;
    webkitAudioContext?: typeof AudioContext;
  }
}
export {};

type SessionSummary = {
  totalBlinks: number;
  normalBlinks: number;
  microBlinks: number;

  totalVisibleTimeMs: number;
  totalHiddenTimeMs: number;
  totalSessionTimeMs: number;
  averageBlinksPerMinute: number;

  totalAlerts: number;
  longestNoBlinkMs: number;
  visibilityPercent: number;
  blinkCompliancePercent: number;

  blinkIntegralMs: number;
  averageBlinkSpacingMs: number | null;
  blinkSpacingStdMs: number | null;
  blinkIntervalVarianceMs2: number | null;
  blinkIntervalSkewness: number | null;
  blinkRegularityIndex: number | null;

  score: number | null;
  grade: string;
  gradeReason: string;
  finalAdaptiveThresholdSec: number;
};

type UserBlinkProfile = {
  avgBlinkSpacingMs: number | null;
  avgBpm: number | null;
  microBlinkRatio: number | null;
  regularityIndex: number | null;
  preferredThresholdSec: number;
  totalSessions: number;
  updatedAt: number;
};

type ReminderHelpfulness = "yes" | "somewhat" | "no";
type DetectionAccuracy = "very accurate" | "mostly accurate" | "not accurate";
type AlertFrequency = "yes" | "no";

type SessionFeedback = {
  experienceRating: number | null;
  reminderHelpfulness: ReminderHelpfulness | null;
  detectionAccuracy: DetectionAccuracy | null;
  alertsTooFrequent: AlertFrequency | null;
  technicalIssues: string;
  additionalFeedback: string;
};

const initialFeedback: SessionFeedback = {
  experienceRating: null,
  reminderHelpfulness: null,
  detectionAccuracy: null,
  alertsTooFrequent: null,
  technicalIssues: "",
  additionalFeedback: "",
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
    const existing = document.querySelector(`script[src="${src}"]`) as LoadableScriptElement | null;
    if (existing) {
      if (existing._loaded) return resolve();
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error(`Failed to load ${src}`)), { once: true });
      return;
    }

    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => {
      (s as LoadableScriptElement)._loaded = true;
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
  normalBlinks: number;
  microBlinks: number;
  blinksPerMin: number;
  secondsSinceBlink: number;
  alertOn: boolean;
  noBlinkThreshold: number;
  adaptiveThresholdSec: number;
  agreed: boolean;
  error: string | null;
  notifEnabled: boolean;
  notifPermission: "default" | "granted" | "denied";
  faceDetected: boolean;
  devMode: boolean;
};

type Action =
  | { type: "START" }
  | { type: "STOP" }
  | { type: "CALIBRATION_DONE" }
  | { type: "SET_BLINKS"; blinks: number }
  | { type: "SET_NORMAL_BLINKS"; normalBlinks: number }
  | { type: "SET_MICRO_BLINKS"; microBlinks: number }
  | { type: "SET_BPM"; bpm: number }
  | { type: "SET_SECONDS"; seconds: number }
  | { type: "ALERT_ON" }
  | { type: "ALERT_OFF" }
  | { type: "SET_THRESHOLD"; seconds: number }
  | { type: "SET_ADAPTIVE_THRESHOLD"; seconds: number }
  | { type: "AGREE" }
  | { type: "ERROR"; message: string }
  | { type: "CLEAR_ERROR" }
  | { type: "SET_NOTIF_ENABLED"; enabled: boolean }
  | { type: "SET_NOTIF_PERMISSION"; perm: "default" | "granted" | "denied" }
  | { type: "SET_FACE_DETECTED"; detected: boolean }
  | { type: "TOGGLE_DEV_MODE" };

const initialState: UiState = {
  running: false,
  calibrating: false,
  blinks: 0,
  normalBlinks: 0,
  microBlinks: 0,
  blinksPerMin: 0,
  secondsSinceBlink: 0,
  alertOn: false,
  noBlinkThreshold: 10,
  adaptiveThresholdSec: 10,
  agreed: false,
  error: null,
  notifEnabled: true,
  notifPermission: "default",
  faceDetected: false,
  devMode: false,
};

function reducer(state: UiState, action: Action): UiState {
  switch (action.type) {
    case "START":
      return {
        ...initialState,
        running: true,
        calibrating: true,
        noBlinkThreshold: state.noBlinkThreshold,
        adaptiveThresholdSec: state.noBlinkThreshold,
        agreed: state.agreed,
        notifEnabled: state.notifEnabled,
        notifPermission: state.notifPermission,
        devMode: state.devMode,
      };

    case "STOP":
      return { ...state, running: false, calibrating: false, alertOn: false, faceDetected: false };

    case "CALIBRATION_DONE":
      return { ...state, calibrating: false, secondsSinceBlink: 0, alertOn: false };

    case "SET_BLINKS":
      return { ...state, blinks: action.blinks };

    case "SET_NORMAL_BLINKS":
      return { ...state, normalBlinks: action.normalBlinks };

    case "SET_MICRO_BLINKS":
      return { ...state, microBlinks: action.microBlinks };

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

    case "SET_ADAPTIVE_THRESHOLD":
      return { ...state, adaptiveThresholdSec: action.seconds };

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

    case "TOGGLE_DEV_MODE":
      return { ...state, devMode: !state.devMode };

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

function formatSecondsMs(ms: number | null) {
  if (ms === null) return "N/A";
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatVariance(ms2: number | null) {
  if (ms2 === null) return "N/A";
  return `${ms2.toFixed(0)} ms²`;
}

function formatNumber(value: number | null, digits = 2) {
  if (value === null) return "N/A";
  return value.toFixed(digits);
}

function mean(nums: number[]) {
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function variance(nums: number[]) {
  if (nums.length < 2) return null;
  const avg = mean(nums);
  if (avg === null) return null;
  return nums.reduce((acc, n) => acc + (n - avg) ** 2, 0) / nums.length;
}

function stdDev(nums: number[]) {
  const v = variance(nums);
  if (v === null) return null;
  return Math.sqrt(v);
}

function skewness(nums: number[]) {
  if (nums.length < 3) return null;
  const avg = mean(nums);
  const sd = stdDev(nums);
  if (avg === null || sd === null || sd <= 1e-9) return null;

  const thirdMoment = nums.reduce((acc, n) => acc + ((n - avg) / sd) ** 3, 0) / nums.length;
  return thirdMoment;
}

function drawPoint(ctx: CanvasRenderingContext2D, x: number, y: number, r = 3) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

function drawLine(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function drawMeasurementLabel(ctx: CanvasRenderingContext2D, x: number, y: number, text: string) {
  ctx.font = "12px Arial";
  const textWidth = ctx.measureText(text).width;
  const padX = 6;
  const boxW = textWidth + padX * 2;
  const boxH = 18;

  ctx.fillStyle = "#00ff88";
  ctx.fillRect(x - 4, y - 16, boxW, boxH);

  ctx.fillStyle = "#000";
  ctx.fillText(text, x + padX - 4, y - 3);
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function sigmoid(x: number) {
  return 1 / (1 + Math.exp(-x));
}

function sigmoidPenalty(deviation: number, midpoint: number, steepness: number, maxPenalty: number) {
  if (deviation <= 0) return 0;
  const s = sigmoid(steepness * (deviation - midpoint));
  return maxPenalty * s;
}

function scoreRangeSigmoid(
  value: number,
  idealMin: number,
  idealMax: number,
  midpoint: number,
  steepness: number
) {
  if (value >= idealMin && value <= idealMax) return 100;

  let deviation = 0;
  if (value < idealMin) deviation = idealMin - value;
  else deviation = value - idealMax;

  const penalty = sigmoidPenalty(deviation, midpoint, steepness, 100);
  return Math.round(clamp(100 - penalty, 0, 100));
}

function computeBlinkRegularityIndex(
  averageBlinkSpacingMs: number | null,
  blinkSpacingStdMs: number | null,
  blinkIntervalSkewness: number | null
) {
  if (
    averageBlinkSpacingMs === null ||
    blinkSpacingStdMs === null ||
    averageBlinkSpacingMs <= 0
  ) {
    return null;
  }

  const cv = blinkSpacingStdMs / averageBlinkSpacingMs;
  const cvPenalty = clamp(cv / 1.0, 0, 1) * 75;
  const skewPenalty =
    blinkIntervalSkewness === null ? 0 : clamp(Math.abs(blinkIntervalSkewness) / 2.5, 0, 1) * 25;

  return Math.round(clamp(100 - cvPenalty - skewPenalty, 0, 100));
}

function computeAdaptiveThresholdSec(args: {
  baseThresholdSec: number;
  recentIntervalsMs: number[];
  blinkRegularityIndex: number | null;
  microBlinkRatio: number;
}) {
  const { baseThresholdSec, recentIntervalsMs, blinkRegularityIndex, microBlinkRatio } = args;

  let threshold = baseThresholdSec;
  const recentAvg = mean(recentIntervalsMs);

  if (recentAvg !== null) {
    const recentAvgSec = recentAvg / 1000;

    if (recentAvgSec <= 3.0) threshold += 1.5;
    else if (recentAvgSec <= 4.0) threshold += 0.5;
    else if (recentAvgSec >= 6.5) threshold -= 1.5;
    else if (recentAvgSec >= 5.5) threshold -= 0.5;
  }

  if (blinkRegularityIndex !== null) {
    if (blinkRegularityIndex >= 85) threshold += 0.75;
    else if (blinkRegularityIndex < 60) threshold -= 1.0;
  }

  if (microBlinkRatio > 0.35) threshold -= 1.0;
  else if (microBlinkRatio > 0.2) threshold -= 0.5;

  return clamp(Number(threshold.toFixed(1)), 5, 15);
}

function getStoredProfile(): UserBlinkProfile | null {
  try {
    const raw = localStorage.getItem("userBlinkProfile");
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveStoredProfile(profile: UserBlinkProfile) {
  try {
    localStorage.setItem("userBlinkProfile", JSON.stringify(profile));
  } catch {
    // ignore
  }
}

function averageNullable(oldValue: number | null, newValue: number | null, count: number) {
  if (newValue === null) return oldValue;
  if (oldValue === null) return newValue;
  return (oldValue * count + newValue) / (count + 1);
}

function computePersonalThreshold(args: {
  avgBlinkSpacingMs: number | null;
  avgBpm: number | null;
  microBlinkRatio: number | null;
  regularityIndex: number | null;
  fallbackThresholdSec: number;
}) {
  const {
    avgBlinkSpacingMs,
    avgBpm,
    microBlinkRatio,
    regularityIndex,
    fallbackThresholdSec,
  } = args;

  let threshold = fallbackThresholdSec;

  if (avgBlinkSpacingMs !== null) {
    const spacingSec = avgBlinkSpacingMs / 1000;

    if (spacingSec >= 5.5) threshold += 1.5;
    else if (spacingSec >= 4.5) threshold += 0.75;
    else if (spacingSec <= 3.0) threshold -= 1.0;
    else if (spacingSec <= 3.5) threshold -= 0.5;
  }

  if (avgBpm !== null) {
    if (avgBpm < 12) threshold += 0.75;
    else if (avgBpm > 24) threshold -= 0.75;
  }

  if (microBlinkRatio !== null) {
    if (microBlinkRatio > 0.35) threshold -= 1.0;
    else if (microBlinkRatio > 0.2) threshold -= 0.5;
  }

  if (regularityIndex !== null) {
    if (regularityIndex >= 85) threshold += 0.5;
    else if (regularityIndex < 60) threshold -= 0.75;
  }

  return clamp(Number(threshold.toFixed(1)), 5, 15);
}

function gradeSession(args: {
  visibleMs: number;
  totalMs: number;
  bpm: number;
  alerts: number;
  longestNoBlinkMs: number;
  riskyVisibleMs: number;
  blinkIntegralMs: number;
  averageBlinkSpacingMs: number | null;
  blinkSpacingStdMs: number | null;
  blinkIntervalVarianceMs2: number | null;
  blinkIntervalSkewness: number | null;
  blinkRegularityIndex: number | null;
  microBlinkRatio: number;
}) {
  const {
    visibleMs,
    totalMs,
    bpm,
    alerts,
    longestNoBlinkMs,
    riskyVisibleMs,
    blinkIntegralMs,
    averageBlinkSpacingMs,
    blinkSpacingStdMs,
    blinkIntervalVarianceMs2,
    blinkIntervalSkewness,
    blinkRegularityIndex,
    microBlinkRatio,
  } = args;

  const visibilityPercent = totalMs > 0 ? (visibleMs / totalMs) * 100 : 0;
  const blinkCompliancePercent = visibleMs > 0 ? ((visibleMs - riskyVisibleMs) / visibleMs) * 100 : 0;
  const visibleMinutes = visibleMs / 60000;
  const longestNoBlinkSec = longestNoBlinkMs / 1000;
  const blinkIntegralPerMinute = visibleMinutes > 0 ? blinkIntegralMs / visibleMinutes : 0;

  if (visibleMinutes < 0.5) {
    return {
      score: null,
      grade: "N/A",
      gradeReason: "could not determine grade because visible session time was too short",
      visibilityPercent,
      blinkCompliancePercent,
    };
  }

  const blinkRateScore = scoreRangeSigmoid(bpm, 15, 25, 4, 0.9);

  let sustainedScore = clamp(blinkCompliancePercent, 0, 100);
  if (longestNoBlinkSec > 10) {
    sustainedScore -= sigmoidPenalty(longestNoBlinkSec - 10, 4, 0.8, 12);
  }
  sustainedScore = Math.round(clamp(sustainedScore, 0, 100));

  const visibilityScore = Math.round(clamp(visibilityPercent, 0, 100));

  const rhythmSubscores: number[] = [];

  if (averageBlinkSpacingMs !== null) {
    const avgSpacingSec = averageBlinkSpacingMs / 1000;
    rhythmSubscores.push(scoreRangeSigmoid(avgSpacingSec, 3, 5, 1.4, 1.15));
  }

  if (blinkRegularityIndex !== null) {
    rhythmSubscores.push(blinkRegularityIndex);
  }

  if (blinkSpacingStdMs !== null && averageBlinkSpacingMs !== null && averageBlinkSpacingMs > 0) {
    const cv = blinkSpacingStdMs / averageBlinkSpacingMs;
    const cvPenalty = sigmoidPenalty(Math.max(0, cv - 0.25), 0.2, 7, 100);
    rhythmSubscores.push(Math.round(clamp(100 - cvPenalty, 0, 100)));
  }

  if (blinkIntervalVarianceMs2 !== null && averageBlinkSpacingMs !== null && averageBlinkSpacingMs > 0) {
    const normalizedVariance = blinkIntervalVarianceMs2 / (averageBlinkSpacingMs * averageBlinkSpacingMs);
    const variancePenalty = sigmoidPenalty(Math.max(0, normalizedVariance - 0.08), 0.12, 8, 100);
    rhythmSubscores.push(Math.round(clamp(100 - variancePenalty, 0, 100)));
  }

  if (blinkIntervalSkewness !== null) {
    const skewPenalty = sigmoidPenalty(Math.max(0, Math.abs(blinkIntervalSkewness) - 0.5), 0.5, 4, 100);
    rhythmSubscores.push(Math.round(clamp(100 - skewPenalty, 0, 100)));
  }

  const microBlinkPercent = microBlinkRatio * 100;
  const microBlinkPenalty = sigmoidPenalty(Math.max(0, microBlinkPercent - 10), 10, 0.22, 100);
  rhythmSubscores.push(Math.round(clamp(100 - microBlinkPenalty, 0, 100)));

  const rhythmScore =
    rhythmSubscores.length > 0
      ? Math.round(rhythmSubscores.reduce((a, b) => a + b, 0) / rhythmSubscores.length)
      : 100;

  let sessionQualityScore = 100;

  if (visibleMinutes < 1) {
    sessionQualityScore -= sigmoidPenalty(1 - visibleMinutes, 0.2, 8, 18);
  }

  if (blinkIntegralPerMinute < 1800) {
    sessionQualityScore -= sigmoidPenalty(1800 - blinkIntegralPerMinute, 350, 0.01, 14);
  }

  if (alerts > 0) {
    sessionQualityScore -= sigmoidPenalty(alerts, 2, 1.1, 12);
  }

  sessionQualityScore = Math.round(clamp(sessionQualityScore, 0, 100));

  const score = Math.round(
    blinkRateScore * 0.22 +
      sustainedScore * 0.23 +
      visibilityScore * 0.12 +
      rhythmScore * 0.28 +
      sessionQualityScore * 0.15
  );

  let grade = "F";
  if (score >= 88) grade = "A";
  else if (score >= 76) grade = "B";
  else if (score >= 64) grade = "C";
  else if (score >= 52) grade = "D";

  const reasons: string[] = [];
  if (blinkRateScore < 80) reasons.push("blink rate was outside the preferred range");
  if (sustainedScore < 80) reasons.push("there were extended no-blink periods");
  if (visibilityScore < 80) reasons.push("face visibility was not consistent");
  if (rhythmScore < 80) reasons.push("blinking was irregular or included too many micro blinks");
  if (sessionQualityScore < 80) reasons.push("session quality was limited");

  const gradeReason =
    reasons.length > 0
      ? reasons.join(", ")
      : "steady blinking, good visibility, and regular blink behavior";

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
  const [pendingSessionSummary, setPendingSessionSummary] = useState<SessionSummary | null>(null);
  const [sessionDocId, setSessionDocId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<SessionFeedback>(initialFeedback);
  const [feedbackSaving, setFeedbackSaving] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [hasAgreed, setHasAgreed] = useState(false);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
  if (!mounted) return;

  let savedUserId = localStorage.getItem("userId");

  if (!savedUserId) {
    savedUserId =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : "user-" + Math.random().toString(36).substring(2) + Date.now();

    localStorage.setItem("userId", savedUserId);
  }

  setUserId(savedUserId);
}, [mounted]);

  const [state, dispatch] = useReducer(reducer, initialState);
  const {
    running,
    calibrating,
    blinks,
    normalBlinks,
    microBlinks,
    blinksPerMin,
    secondsSinceBlink,
    alertOn,
    noBlinkThreshold,
    adaptiveThresholdSec,
    error,
    notifEnabled,
    notifPermission,
    faceDetected,
    devMode,
  } = state;

  const videoRef = useRef<HTMLVideoElement>(null);
  const hiddenCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const meshRef = useRef<FaceMeshInstance | null>(null);
  const activeRef = useRef(false);
  const startingRef = useRef(false);
  const faceDetectedRef = useRef(false);
  const faceMissingSinceRef = useRef<number | null>(null);
  const stopRef = useRef<(() => Promise<void>) | null>(null);

  const baselineEarRef = useRef<number | null>(null);
  const calibStartRef = useRef<number | null>(null);
  const maxEarRef = useRef(0);
  const openSamplesRef = useRef<number[]>([]);

  const eyeStateRef = useRef<"OPEN" | "CLOSED">("OPEN");
  const closedFramesRef = useRef(0);
  const closedStartMsRef = useRef<number | null>(null);
  const lastBlinkMsRef = useRef(0);

  const lastBlinkVisibleTotalMsRef = useRef<number | null>(null);
  const lastAlertAtRef = useRef(0);
  const lastMetricsUpdateMsRef = useRef<number | null>(null);

  const sessionStartRef = useRef<number | null>(null);
  const blinkCountRef = useRef(0);
  const normalBlinkCountRef = useRef(0);
  const microBlinkCountRef = useRef(0);

  const totalVisibleTimeMsRef = useRef(0);
  const totalHiddenTimeMsRef = useRef(0);
  const visibleSegmentStartRef = useRef<number | null>(null);
  const hiddenSegmentStartRef = useRef<number | null>(null);

  const alertCountRef = useRef(0);
  const longestNoBlinkMsRef = useRef(0);
  const riskyVisibleTimeMsRef = useRef(0);
  const blinkIntegralMsRef = useRef(0);

  const blinkIntervalsRef = useRef<number[]>([]);
  const blinkDurationsRef = useRef<number[]>([]);
  const adaptiveThresholdRef = useRef(10);

  const devMetricsRef = useRef({
    leftEAR: 0,
    rightEAR: 0,
    avgEAR: 0,
    leftV1: 0,
    leftV2: 0,
    rightV1: 0,
    rightV2: 0,
    leftH: 0,
    rightH: 0,
    leftOpenAvg: 0,
    rightOpenAvg: 0,
  });

  const audioCtxRef = useRef<AudioContext | null>(null);

  const lastNotifAtRef = useRef(0);
  const lastAlertOnRef = useRef(false);
  const NOTIF_COOLDOWN_MS = 5000;

  const CALIBRATION_MS = 3000;
  const CLOSE_RATIO = 0.62;
  const OPEN_RATIO = 0.82;
  const MIN_CLOSED_FRAMES = 2;
  const MIN_BLINK_GAP_MS = 350;
  const MICRO_BLINK_MS = 120;
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

  function updateAdaptiveThreshold() {
    const avgSpacing = mean(blinkIntervalsRef.current);
    const spacingStd = stdDev(blinkIntervalsRef.current);
    const spacingSkew = skewness(blinkIntervalsRef.current);

    const blinkRegularityIndex = computeBlinkRegularityIndex(avgSpacing, spacingStd, spacingSkew);
    const totalBlinksSoFar = blinkCountRef.current;
    const microBlinkRatio =
      totalBlinksSoFar > 0 ? microBlinkCountRef.current / totalBlinksSoFar : 0;
    const recentIntervals = blinkIntervalsRef.current.slice(-6);

    const adaptive = computeAdaptiveThresholdSec({
      baseThresholdSec: noBlinkThreshold,
      recentIntervalsMs: recentIntervals,
      blinkRegularityIndex,
      microBlinkRatio,
    });

    adaptiveThresholdRef.current = adaptive;
    dispatch({ type: "SET_ADAPTIVE_THRESHOLD", seconds: adaptive });
  }

  useEffect(() => {
    if (!mounted) return;

    try {
      const savedProfile = getStoredProfile();
      const savedThreshold = localStorage.getItem("noBlinkThreshold");
      const savedNotif = localStorage.getItem("notifEnabled");

      let initialThreshold = 10;

      if (savedProfile && Number.isFinite(savedProfile.preferredThresholdSec)) {
        initialThreshold = savedProfile.preferredThresholdSec;
      }

      if (savedThreshold) {
        const n = Number(savedThreshold);
        if (Number.isFinite(n) && n > 0) {
          initialThreshold = n;
        }
      }

      dispatch({ type: "SET_THRESHOLD", seconds: initialThreshold });
      dispatch({ type: "SET_ADAPTIVE_THRESHOLD", seconds: initialThreshold });
      adaptiveThresholdRef.current = initialThreshold;

      if (savedNotif !== null) {
        dispatch({ type: "SET_NOTIF_ENABLED", enabled: savedNotif === "true" });
      }
    } catch {
      // ignore
    }
  }, [mounted]);

  function beep() {
    const AudioCtx =
      window.AudioContext || window.webkitAudioContext;
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
    dispatch({ type: "SET_ADAPTIVE_THRESHOLD", seconds });
    adaptiveThresholdRef.current = seconds;

    if (mounted) {
      try {
        localStorage.setItem("noBlinkThreshold", String(seconds));

        const existingProfile = getStoredProfile();
        if (existingProfile) {
          saveStoredProfile({
            ...existingProfile,
            preferredThresholdSec: seconds,
            updatedAt: Date.now(),
          });
        }
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
    closedStartMsRef.current = null;
    lastBlinkMsRef.current = 0;

    lastBlinkVisibleTotalMsRef.current = null;
    lastAlertAtRef.current = 0;
    lastMetricsUpdateMsRef.current = null;

    sessionStartRef.current = null;
    blinkCountRef.current = 0;
    normalBlinkCountRef.current = 0;
    microBlinkCountRef.current = 0;

    totalVisibleTimeMsRef.current = 0;
    totalHiddenTimeMsRef.current = 0;
    visibleSegmentStartRef.current = null;
    hiddenSegmentStartRef.current = null;

    alertCountRef.current = 0;
    longestNoBlinkMsRef.current = 0;
    riskyVisibleTimeMsRef.current = 0;
    blinkIntegralMsRef.current = 0;

    blinkIntervalsRef.current = [];
    blinkDurationsRef.current = [];
    adaptiveThresholdRef.current = noBlinkThreshold;

    devMetricsRef.current = {
      leftEAR: 0,
      rightEAR: 0,
      avgEAR: 0,
      leftV1: 0,
      leftV2: 0,
      rightV1: 0,
      rightV2: 0,
      leftH: 0,
      rightH: 0,
      leftOpenAvg: 0,
      rightOpenAvg: 0,
    };

    lastBpmUpdateRef.current = 0;
    lastNotifAtRef.current = 0;
    lastAlertOnRef.current = false;
    faceDetectedRef.current = false;
    faceMissingSinceRef.current = null;

    dispatch({ type: "SET_FACE_DETECTED", detected: false });
    dispatch({ type: "SET_SECONDS", seconds: 0 });
    dispatch({ type: "ALERT_OFF" });
    dispatch({ type: "SET_BLINKS", blinks: 0 });
    dispatch({ type: "SET_NORMAL_BLINKS", normalBlinks: 0 });
    dispatch({ type: "SET_MICRO_BLINKS", microBlinks: 0 });
    dispatch({ type: "SET_BPM", bpm: 0 });
    dispatch({ type: "SET_ADAPTIVE_THRESHOLD", seconds: noBlinkThreshold });

    const overlay = overlayCanvasRef.current;
    if (overlay) {
      const octx = overlay.getContext("2d");
      if (octx) octx.clearRect(0, 0, overlay.width, overlay.height);
    }
  }

  function cleanupLoopsAndStream() {
    activeRef.current = false;

    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;

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

    const overlay = overlayCanvasRef.current;
    if (overlay) {
      const octx = overlay.getContext("2d");
      if (octx) octx.clearRect(0, 0, overlay.width, overlay.height);
    }
  }

  async function start() {
    if (!hasAgreed || running || startingRef.current) return;
    startingRef.current = true;

    dispatch({ type: "CLEAR_ERROR" });
    resetRefs();
    setSessionSummary(null);
    setPendingSessionSummary(null);
    setSessionDocId(null);
    setFeedback(initialFeedback);
    setFeedbackSaving(false);
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

      mesh.onResults((res: FaceMeshResults) => {
        if (!activeRef.current) return;

        const now = performance.now();
        const prevMetricsNow = lastMetricsUpdateMsRef.current;
        const deltaMs = prevMetricsNow === null ? 0 : Math.max(0, now - prevMetricsNow);
        lastMetricsUpdateMsRef.current = now;

        const videoEl = videoRef.current;
        const overlay = overlayCanvasRef.current;
        const landmarks = res.multiFaceLandmarks;
        const hasFace = !!landmarks?.length;

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
            dispatch({ type: "ALERT_OFF" });
            lastAlertOnRef.current = false;

            if (overlay) {
              const octx = overlay.getContext("2d");
              if (octx) octx.clearRect(0, 0, overlay.width, overlay.height);
            }
          }

          return;
        }

        const lm = landmarks[0];

        const L = { p1: 33, p2: 160, p3: 159, p4: 133, p5: 145, p6: 144 };
        const R = { p1: 362, p2: 387, p3: 386, p4: 263, p5: 374, p6: 373 };

        const left = ear(lm[L.p1], lm[L.p2], lm[L.p3], lm[L.p4], lm[L.p5], lm[L.p6]);
        const right = ear(lm[R.p1], lm[R.p2], lm[R.p3], lm[R.p4], lm[R.p5], lm[R.p6]);
        const curEar = (left + right) / 2;

        if (videoEl) {
          const toPx = (p: Point) => ({
            x: p.x * videoEl.videoWidth,
            y: p.y * videoEl.videoHeight,
          });

          const lp1 = toPx(lm[L.p1]);
          const lp2 = toPx(lm[L.p2]);
          const lp3 = toPx(lm[L.p3]);
          const lp4 = toPx(lm[L.p4]);
          const lp5 = toPx(lm[L.p5]);
          const lp6 = toPx(lm[L.p6]);

          const rp1 = toPx(lm[R.p1]);
          const rp2 = toPx(lm[R.p2]);
          const rp3 = toPx(lm[R.p3]);
          const rp4 = toPx(lm[R.p4]);
          const rp5 = toPx(lm[R.p5]);
          const rp6 = toPx(lm[R.p6]);

          const leftV1 = dist(lp2, lp6);
          const leftV2 = dist(lp3, lp5);
          const leftH = dist(lp1, lp4);

          const rightV1 = dist(rp2, rp6);
          const rightV2 = dist(rp3, rp5);
          const rightH = dist(rp1, rp4);

          const leftMid1 = {
            x: (lp2.x + lp6.x) / 2,
            y: (lp2.y + lp6.y) / 2,
          };
          const leftMid2 = {
            x: (lp3.x + lp5.x) / 2,
            y: (lp3.y + lp5.y) / 2,
          };
          const rightMid1 = {
            x: (rp2.x + rp6.x) / 2,
            y: (rp2.y + rp6.y) / 2,
          };
          const rightMid2 = {
            x: (rp3.x + rp5.x) / 2,
            y: (rp3.y + rp5.y) / 2,
          };

          const leftOpenAvg = (leftV1 + leftV2) / 2;
          const rightOpenAvg = (rightV1 + rightV2) / 2;

          devMetricsRef.current = {
            leftEAR: left,
            rightEAR: right,
            avgEAR: curEar,
            leftV1,
            leftV2,
            rightV1,
            rightV2,
            leftH,
            rightH,
            leftOpenAvg,
            rightOpenAvg,
          };

          if (devMode && overlay) {
            overlay.width = videoEl.videoWidth || 640;
            overlay.height = videoEl.videoHeight || 480;

            const octx = overlay.getContext("2d");
            if (octx) {
              octx.clearRect(0, 0, overlay.width, overlay.height);

              octx.lineWidth = 2;
              octx.fillStyle = "#00ff88";
              octx.strokeStyle = "#00ff88";

              [lp1, lp2, lp3, lp4, lp5, lp6, rp1, rp2, rp3, rp4, rp5, rp6].forEach((p) => {
                drawPoint(octx, p.x, p.y, 4);
              });

              octx.strokeStyle = "#00bfff";
              drawLine(octx, lp1.x, lp1.y, lp4.x, lp4.y);
              drawLine(octx, lp2.x, lp2.y, lp6.x, lp6.y);
              drawLine(octx, lp3.x, lp3.y, lp5.x, lp5.y);

              drawLine(octx, rp1.x, rp1.y, rp4.x, rp4.y);
              drawLine(octx, rp2.x, rp2.y, rp6.x, rp6.y);
              drawLine(octx, rp3.x, rp3.y, rp5.x, rp5.y);

              octx.strokeStyle = "#00ff88";
              octx.lineWidth = 3;

              drawLine(octx, leftMid1.x - 14, leftMid1.y, leftMid1.x - 14, leftMid1.y - leftV1);
              drawLine(octx, leftMid2.x - 20, leftMid2.y, leftMid2.x - 20, leftMid2.y - leftV2);

              drawLine(octx, rightMid1.x + 14, rightMid1.y, rightMid1.x + 14, rightMid1.y - rightV1);
              drawLine(octx, rightMid2.x + 20, rightMid2.y, rightMid2.x + 20, rightMid2.y - rightV2);

              drawMeasurementLabel(octx, leftMid1.x - 68, leftMid1.y - 6, `${leftV1.toFixed(1)} px`);
              drawMeasurementLabel(octx, leftMid2.x - 74, leftMid2.y + 18, `${leftV2.toFixed(1)} px`);

              drawMeasurementLabel(octx, rightMid1.x + 18, rightMid1.y - 6, `${rightV1.toFixed(1)} px`);
              drawMeasurementLabel(octx, rightMid2.x + 24, rightMid2.y + 18, `${rightV2.toFixed(1)} px`);

              octx.fillStyle = "#ffffff";
              octx.font = "16px Arial";
              octx.fillText(`Left EAR: ${left.toFixed(3)}`, 16, 28);
              octx.fillText(`Right EAR: ${right.toFixed(3)}`, 16, 50);
              octx.fillText(`Avg EAR: ${curEar.toFixed(3)}`, 16, 72);
              octx.fillText(`Eye Open L: ${leftOpenAvg.toFixed(1)} px`, 16, 94);
              octx.fillText(`Eye Open R: ${rightOpenAvg.toFixed(1)} px`, 16, 116);
            }
          } else if (overlay) {
            const octx = overlay.getContext("2d");
            if (octx) octx.clearRect(0, 0, overlay.width, overlay.height);
          }
        }

        if (baselineEarRef.current === null) {
          if (calibStartRef.current === null) calibStartRef.current = now;

          maxEarRef.current = Math.max(maxEarRef.current, curEar);
          if (curEar > maxEarRef.current * 0.8) openSamplesRef.current.push(curEar);

          if (now - (calibStartRef.current ?? now) >= CALIBRATION_MS) {
            const samples = openSamplesRef.current;
            baselineEarRef.current =
              samples.length > 0 ? samples.reduce((a, b) => a + b, 0) / samples.length : maxEarRef.current;

            lastBlinkVisibleTotalMsRef.current = getVisibleTotalMs(now);
            lastMetricsUpdateMsRef.current = now;
            dispatch({ type: "CALIBRATION_DONE" });
            dispatch({ type: "SET_SECONDS", seconds: 0 });
            dispatch({ type: "ALERT_OFF" });
            updateAdaptiveThreshold();
          }

          return;
        }

        const baseline = baselineEarRef.current;
        const closeThr = baseline * CLOSE_RATIO;
        const openThr = baseline * OPEN_RATIO;

        if (eyeStateRef.current === "OPEN") {
          if (curEar < closeThr) {
            closedFramesRef.current = 1;
            closedStartMsRef.current = now;
            eyeStateRef.current = "CLOSED";
          }
        } else {
          blinkIntegralMsRef.current += deltaMs;

          if (curEar < closeThr) {
            closedFramesRef.current += 1;
          }

          if (curEar > openThr) {
            const longEnough = closedFramesRef.current >= MIN_CLOSED_FRAMES;
            const farEnough = now - lastBlinkMsRef.current >= MIN_BLINK_GAP_MS;

            if (longEnough && farEnough) {
              const currentVisibleTotal = getVisibleTotalMs(now);
              const blinkDuration =
                closedStartMsRef.current === null ? 0 : Math.max(0, now - closedStartMsRef.current);

              blinkDurationsRef.current.push(blinkDuration);

              if (lastBlinkVisibleTotalMsRef.current !== null) {
                const spacingMs = Math.max(0, currentVisibleTotal - lastBlinkVisibleTotalMsRef.current);
                if (spacingMs > 0) {
                  blinkIntervalsRef.current.push(spacingMs);
                }
              }

              const isMicroBlink = blinkDuration > 0 && blinkDuration < MICRO_BLINK_MS;

              blinkCountRef.current += 1;
              dispatch({ type: "SET_BLINKS", blinks: blinkCountRef.current });

              if (isMicroBlink) {
                microBlinkCountRef.current += 1;
                dispatch({ type: "SET_MICRO_BLINKS", microBlinks: microBlinkCountRef.current });
              } else {
                normalBlinkCountRef.current += 1;
                dispatch({ type: "SET_NORMAL_BLINKS", normalBlinks: normalBlinkCountRef.current });
              }

              lastBlinkMsRef.current = now;
              lastBlinkVisibleTotalMsRef.current = currentVisibleTotal;
              dispatch({ type: "SET_SECONDS", seconds: 0 });
              dispatch({ type: "ALERT_OFF" });
              lastAlertOnRef.current = false;

              updateAdaptiveThreshold();
            }

            eyeStateRef.current = "OPEN";
            closedFramesRef.current = 0;
            closedStartMsRef.current = null;
          }
        }

        const visibleElapsedMs =
          lastBlinkVisibleTotalMsRef.current === null
            ? 0
            : Math.max(0, getVisibleTotalMs(now) - lastBlinkVisibleTotalMsRef.current);

        if (visibleElapsedMs > longestNoBlinkMsRef.current) {
          longestNoBlinkMsRef.current = visibleElapsedMs;
        }

        const sec = visibleElapsedMs / 1000;
        dispatch({ type: "SET_SECONDS", seconds: sec });

        const currentAdaptiveThreshold = adaptiveThresholdRef.current;

        if (sec >= currentAdaptiveThreshold) {
          riskyVisibleTimeMsRef.current += deltaMs;
          dispatch({ type: "ALERT_ON" });

          if (!lastAlertOnRef.current) {
            lastAlertOnRef.current = true;
            alertCountRef.current += 1;
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

        const visibleMinutes = getVisibleTotalMs(now) / 60000;
        const bpmNow = visibleMinutes > 0 ? blinkCountRef.current / visibleMinutes : 0;

        if (now - lastBpmUpdateRef.current >= BPM_UPDATE_MS) {
          lastBpmUpdateRef.current = now;
          dispatch({ type: "SET_BPM", bpm: bpmNow });
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
    } catch (e: unknown) {
      cleanupLoopsAndStream();
      dispatch({ type: "ERROR", message: e instanceof Error ? e.message : "Failed to start." });
    } finally {
      startingRef.current = false;
    }
  }

  async function stop() {
  const now = performance.now();
  finalizeTiming(now);

  const totalVisible = totalVisibleTimeMsRef.current;
  const totalHidden = totalHiddenTimeMsRef.current;
  const totalSessionTime =
    sessionStartRef.current !== null
      ? Math.max(0, now - sessionStartRef.current)
      : totalVisible + totalHidden;

  const averageBlinksPerMinute =
    totalVisible > 0 ? blinkCountRef.current / (totalVisible / 60000) : 0;

  const averageBlinkSpacingMs = mean(blinkIntervalsRef.current);
  const blinkSpacingStdMs = stdDev(blinkIntervalsRef.current);
  const blinkIntervalVarianceMs2 = variance(blinkIntervalsRef.current);
  const blinkIntervalSkewness = skewness(blinkIntervalsRef.current);

  const blinkRegularityIndex = computeBlinkRegularityIndex(
    averageBlinkSpacingMs,
    blinkSpacingStdMs,
    blinkIntervalSkewness
  );

  const microBlinkRatio =
    blinkCountRef.current > 0
      ? microBlinkCountRef.current / blinkCountRef.current
      : 0;

  const grading = gradeSession({
    visibleMs: totalVisible,
    totalMs: totalSessionTime,
    bpm: averageBlinksPerMinute,
    alerts: alertCountRef.current,
    longestNoBlinkMs: longestNoBlinkMsRef.current,
    riskyVisibleMs: riskyVisibleTimeMsRef.current,
    blinkIntegralMs: blinkIntegralMsRef.current,
    averageBlinkSpacingMs,
    blinkSpacingStdMs,
    blinkIntervalVarianceMs2,
    blinkIntervalSkewness,
    blinkRegularityIndex,
    microBlinkRatio,
  });

  const summary: SessionSummary = {
    totalBlinks: blinkCountRef.current,
    normalBlinks: normalBlinkCountRef.current,
    microBlinks: microBlinkCountRef.current,

    totalVisibleTimeMs: totalVisible,
    totalHiddenTimeMs: totalHidden,
    totalSessionTimeMs: totalSessionTime,
    averageBlinksPerMinute,

    totalAlerts: alertCountRef.current,
    longestNoBlinkMs: longestNoBlinkMsRef.current,
    visibilityPercent: grading.visibilityPercent,
    blinkCompliancePercent: grading.blinkCompliancePercent,

    blinkIntegralMs: blinkIntegralMsRef.current,
    averageBlinkSpacingMs,
    blinkSpacingStdMs,
    blinkIntervalVarianceMs2,
    blinkIntervalSkewness,
    blinkRegularityIndex,

    score: grading.score,
    grade: grading.grade,
    gradeReason: grading.gradeReason,
    finalAdaptiveThresholdSec: adaptiveThresholdRef.current,
  };

  try {
    const oldProfile = getStoredProfile();
    const oldCount = oldProfile?.totalSessions ?? 0;

    const mergedAvgSpacing = averageNullable(
      oldProfile?.avgBlinkSpacingMs ?? null,
      averageBlinkSpacingMs,
      oldCount
    );

    const mergedAvgBpm = averageNullable(
      oldProfile?.avgBpm ?? null,
      averageBlinksPerMinute,
      oldCount
    );

    const mergedMicroRatio = averageNullable(
      oldProfile?.microBlinkRatio ?? null,
      microBlinkRatio,
      oldCount
    );

    const mergedRegularity = averageNullable(
      oldProfile?.regularityIndex ?? null,
      blinkRegularityIndex,
      oldCount
    );

    const manualThresholdRaw = localStorage.getItem("noBlinkThreshold");
    const fallbackThresholdSec = manualThresholdRaw
      ? Number(manualThresholdRaw)
      : noBlinkThreshold;

    const preferredThresholdSec = computePersonalThreshold({
      avgBlinkSpacingMs: mergedAvgSpacing,
      avgBpm: mergedAvgBpm,
      microBlinkRatio: mergedMicroRatio,
      regularityIndex: mergedRegularity,
      fallbackThresholdSec: Number.isFinite(fallbackThresholdSec) ? fallbackThresholdSec : 10,
    });

    saveStoredProfile({
      avgBlinkSpacingMs: mergedAvgSpacing,
      avgBpm: mergedAvgBpm,
      microBlinkRatio: mergedMicroRatio,
      regularityIndex: mergedRegularity,
      preferredThresholdSec,
      totalSessions: oldCount + 1,
      updatedAt: Date.now(),
    });

    dispatch({ type: "SET_THRESHOLD", seconds: preferredThresholdSec });
    dispatch({ type: "SET_ADAPTIVE_THRESHOLD", seconds: preferredThresholdSec });
    adaptiveThresholdRef.current = preferredThresholdSec;
  } catch {
    // ignore
  }

  let savedSessionDocId: string | null = null;

  if (userId && db) {
    try {
      // Only anonymized or pseudonymous session analytics are stored. No webcam images, raw video, or biometric media are uploaded.
      const sessionDoc = await addDoc(collection(db, "sessions"), {
        userId,
        ...summary,
        createdAt: Date.now(),
      });
      savedSessionDocId = sessionDoc.id;
      console.log("Session saved to Firebase");
    } catch (err) {
      console.error("Firebase save error:", err);
    }
  }

  setSessionDocId(savedSessionDocId);
  setPendingSessionSummary(summary);
  setSessionSummary(null);
  setFeedback(initialFeedback);
  dispatch({ type: "STOP" });
  cleanupLoopsAndStream();

  if (audioCtxRef.current) {
    audioCtxRef.current.close().catch(() => {});
    audioCtxRef.current = null;
  }
}

  function showFinalSummary() {
    if (!pendingSessionSummary) return;
    setSessionSummary(pendingSessionSummary);
    setPendingSessionSummary(null);
    setFeedback(initialFeedback);
    setFeedbackSaving(false);
  }

  async function submitFeedback() {
    const summaryToShow = pendingSessionSummary;
    if (!summaryToShow || feedbackSaving) return;

    setFeedbackSaving(true);

    const sanitizedFeedback = {
      experienceRating: feedback.experienceRating,
      reminderHelpfulness: feedback.reminderHelpfulness,
      detectionAccuracy: feedback.detectionAccuracy,
      alertsTooFrequent: feedback.alertsTooFrequent,
      technicalIssues: feedback.technicalIssues.trim(),
      additionalFeedback: feedback.additionalFeedback.trim(),
      submittedAt: Date.now(),
    };

    if (db && sessionDocId) {
      try {
        // Feedback stores only user-entered answers. It never stores video, images, or biometric data.
        await updateDoc(doc(db, "sessions", sessionDocId), {
          feedback: sanitizedFeedback,
        });
        console.log("Feedback saved to Firebase");
      } catch (err) {
        console.error("Feedback save error:", err);
      }
    }

    setSessionSummary(summaryToShow);
    setPendingSessionSummary(null);
    setFeedback(initialFeedback);
    setFeedbackSaving(false);
  }

  function skipFeedback() {
    showFinalSummary();
  }

  useEffect(() => {
    if (!mounted) return;
    if (!("Notification" in window)) return;
    dispatch({ type: "SET_NOTIF_PERMISSION", perm: Notification.permission });
  }, [mounted]);

  stopRef.current = stop;

  useEffect(() => {
    const onVis = () => {
      if (document.hidden && running) {
        void stopRef.current?.();
      }
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
            ? "BLINK! (adaptive alert repeats until you blink)"
            : "Monitoring…";

  const canUseNotifications = mounted && "Notification" in window;

  return (
    <div style={{ background: "#000", color: "#fff", minHeight: "100vh", padding: 20 }}>
      <h1 style={{ margin: 0 }}>Blink Monitor</h1>

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
        <h3 style={{ marginTop: 0, color: "#ffcc66" }}>Privacy & Research Data Notice</h3>

        <p>
          Webcam processing happens locally in your browser. No raw webcam video, images, or facial recordings are stored
          or transmitted.
        </p>

        <p>
          Limited analytics/session data may be stored in Firebase for research, debugging, and system improvement, such as
          blink counts, session duration, blink timing statistics, visibility metrics, adaptive thresholds, and anonymous or
          pseudonymous session identifiers.
        </p>

        <p>
          This app is a research prototype and not a medical device. If you have eye pain, discomfort, or vision issues,
          please stop using this tool and consult a qualified medical professional.
        </p>

        <button
          onClick={() => {
            requestNotifPermission();
            dispatch({ type: "AGREE" });
            setHasAgreed(true);
          }}
          style={{ marginTop: 8, padding: "10px 16px", cursor: hasAgreed ? "default" : "pointer", opacity: hasAgreed ? 0.75 : 1 }}
          disabled={hasAgreed}
        >
          {hasAgreed ? "You agreed" : "I agree"}
        </button>

        {!hasAgreed && (
          <p style={{ marginBottom: 0, marginTop: 10, color: "#cfcfcf", fontSize: 14 }}>
            Please agree to the notice before starting.
          </p>
        )}
      </div>

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
              Base threshold: <b>{noBlinkThreshold}s</b> • Current adaptive threshold: <b>{adaptiveThresholdSec}s</b>
              {" "}• Beep repeats every <b>{(ALERT_REPEAT_MS / 1000).toFixed(1)}s</b>
            </div>

            <div style={{ marginTop: 14, fontSize: 13, opacity: 0.75 }}>
              Tip: The adaptive threshold changes based on recent blink behavior.
            </div>
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 16, flexWrap: "wrap" }}>
        <button
          onClick={() => {
            if (running) stop();
            else void start();
          }}
          style={{
            padding: "8px 14px",
            cursor: hasAgreed && !pendingSessionSummary ? "pointer" : "not-allowed",
            opacity: hasAgreed && !pendingSessionSummary ? 1 : 0.5,
          }}
          disabled={!hasAgreed || !!pendingSessionSummary}
        >
          {running ? "Stop" : "Start"}
        </button>

        <button
          onClick={() => dispatch({ type: "TOGGLE_DEV_MODE" })}
          style={{ padding: "8px 14px", cursor: "pointer" }}
        >
          {devMode ? "Dev Mode On" : "Dev Mode Off"}
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
            Base alert if no blink for{" "}
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
        {pendingSessionSummary && !running ? (
          <div
            style={{
              width: "min(820px, 100%)",
              background: "#111",
              border: "1px solid #333",
              borderRadius: 14,
              padding: 24,
            }}
          >
            <div style={{ fontSize: 24, fontWeight: 700, marginBottom: 8 }}>Session Feedback</div>
            <p style={{ marginTop: 0, marginBottom: 18, opacity: 0.82, lineHeight: 1.5 }}>
              Your feedback is optional and helps improve blink reminders. No video, images, or biometric data are saved.
            </p>

            <div style={{ display: "grid", gap: 18 }}>
              <div>
                <div style={{ fontWeight: 700, marginBottom: 8 }}>How was your experience?</div>
                <div role="radiogroup" aria-label="How was your experience?" style={{ display: "flex", gap: 6 }}>
                  {[1, 2, 3, 4, 5].map((rating) => (
                    <button
                      key={rating}
                      type="button"
                      onClick={() => setFeedback((current) => ({ ...current, experienceRating: rating }))}
                      aria-label={`${rating} star${rating === 1 ? "" : "s"}`}
                      aria-pressed={feedback.experienceRating === rating}
                      style={{
                        border: "1px solid #444",
                        borderRadius: 8,
                        background: feedback.experienceRating !== null && rating <= feedback.experienceRating ? "#3b2a05" : "#0b0b0b",
                        color: feedback.experienceRating !== null && rating <= feedback.experienceRating ? "#ffcc66" : "#777",
                        cursor: "pointer",
                        fontSize: 28,
                        lineHeight: 1,
                        padding: "8px 10px",
                      }}
                    >
                      ★
                    </button>
                  ))}
                </div>
              </div>

              <fieldset style={{ border: "1px solid #222", borderRadius: 10, padding: 12 }}>
                <legend style={{ padding: "0 6px", fontWeight: 700 }}>Did the reminders help you remember to blink?</legend>
                {["yes", "somewhat", "no"].map((value) => (
                  <label key={value} style={{ display: "inline-flex", alignItems: "center", gap: 8, marginRight: 16, marginTop: 8, textTransform: "capitalize" }}>
                    <input
                      type="radio"
                      name="reminder-helpfulness"
                      checked={feedback.reminderHelpfulness === value}
                      onChange={() =>
                        setFeedback((current) => ({
                          ...current,
                          reminderHelpfulness: value as ReminderHelpfulness,
                        }))
                      }
                    />
                    {value}
                  </label>
                ))}
              </fieldset>

              <fieldset style={{ border: "1px solid #222", borderRadius: 10, padding: 12 }}>
                <legend style={{ padding: "0 6px", fontWeight: 700 }}>How accurate was the blink detection?</legend>
                {["very accurate", "mostly accurate", "not accurate"].map((value) => (
                  <label key={value} style={{ display: "inline-flex", alignItems: "center", gap: 8, marginRight: 16, marginTop: 8, textTransform: "capitalize" }}>
                    <input
                      type="radio"
                      name="detection-accuracy"
                      checked={feedback.detectionAccuracy === value}
                      onChange={() =>
                        setFeedback((current) => ({
                          ...current,
                          detectionAccuracy: value as DetectionAccuracy,
                        }))
                      }
                    />
                    {value}
                  </label>
                ))}
              </fieldset>

              <fieldset style={{ border: "1px solid #222", borderRadius: 10, padding: 12 }}>
                <legend style={{ padding: "0 6px", fontWeight: 700 }}>Were the alerts too frequent?</legend>
                {["yes", "no"].map((value) => (
                  <label key={value} style={{ display: "inline-flex", alignItems: "center", gap: 8, marginRight: 16, marginTop: 8, textTransform: "capitalize" }}>
                    <input
                      type="radio"
                      name="alerts-too-frequent"
                      checked={feedback.alertsTooFrequent === value}
                      onChange={() =>
                        setFeedback((current) => ({
                          ...current,
                          alertsTooFrequent: value as AlertFrequency,
                        }))
                      }
                    />
                    {value}
                  </label>
                ))}
              </fieldset>

              <label style={{ display: "grid", gap: 8, fontWeight: 700 }}>
                Did you experience any technical issues? <span style={{ fontWeight: 400, opacity: 0.7 }}>(optional)</span>
                <input
                  type="text"
                  value={feedback.technicalIssues}
                  onChange={(e) => setFeedback((current) => ({ ...current, technicalIssues: e.target.value }))}
                  placeholder="Tell us about any glitches or setup issues"
                  style={{ background: "#0b0b0b", color: "#fff", border: "1px solid #333", borderRadius: 8, padding: "10px 12px" }}
                />
              </label>

              <label style={{ display: "grid", gap: 8, fontWeight: 700 }}>
                Additional feedback <span style={{ fontWeight: 400, opacity: 0.7 }}>(optional)</span>
                <textarea
                  value={feedback.additionalFeedback}
                  onChange={(e) => setFeedback((current) => ({ ...current, additionalFeedback: e.target.value }))}
                  placeholder="Anything else you want to share?"
                  rows={4}
                  style={{ background: "#0b0b0b", color: "#fff", border: "1px solid #333", borderRadius: 8, padding: "10px 12px", resize: "vertical" }}
                />
              </label>
            </div>

            <div style={{ display: "flex", gap: 10, marginTop: 22, flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={() => void submitFeedback()}
                disabled={feedbackSaving}
                style={{ padding: "10px 16px", cursor: feedbackSaving ? "not-allowed" : "pointer", opacity: feedbackSaving ? 0.7 : 1 }}
              >
                {feedbackSaving ? "Submitting…" : "Submit Feedback"}
              </button>

              <button
                type="button"
                onClick={skipFeedback}
                disabled={feedbackSaving}
                style={{ padding: "10px 16px", cursor: feedbackSaving ? "not-allowed" : "pointer", opacity: feedbackSaving ? 0.7 : 1 }}
              >
                Skip
              </button>
            </div>
          </div>
        ) : sessionSummary && !running ? (
          <div
            style={{
              width: "min(820px, 100%)",
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
              <div><b>Total blinks:</b> {sessionSummary.totalBlinks}</div>
              <div><b>Normal blinks:</b> {sessionSummary.normalBlinks}</div>
              <div><b>Micro blinks:</b> {sessionSummary.microBlinks}</div>
              <div><b>Total alerts:</b> {sessionSummary.totalAlerts}</div>
              <div><b>Total visible time:</b> {formatDuration(sessionSummary.totalVisibleTimeMs)}</div>
              <div><b>Total hidden time:</b> {formatDuration(sessionSummary.totalHiddenTimeMs)}</div>
              <div><b>Total session time:</b> {formatDuration(sessionSummary.totalSessionTimeMs)}</div>
              <div><b>Average blinks / min:</b> {sessionSummary.averageBlinksPerMinute.toFixed(1)}</div>
              <div><b>Longest no-blink streak:</b> {formatDuration(sessionSummary.longestNoBlinkMs)}</div>
              <div><b>Face visibility:</b> {sessionSummary.visibilityPercent.toFixed(1)}%</div>
              <div><b>Blink compliance:</b> {sessionSummary.blinkCompliancePercent.toFixed(1)}%</div>
              <div><b>Blink integral:</b> {formatSecondsMs(sessionSummary.blinkIntegralMs)} total eye-closure time</div>
              <div><b>Average blink spacing:</b> {formatSecondsMs(sessionSummary.averageBlinkSpacingMs)}</div>
              <div><b>Blink spacing std dev:</b> {formatSecondsMs(sessionSummary.blinkSpacingStdMs)}</div>
              <div><b>Blink interval variance:</b> {formatVariance(sessionSummary.blinkIntervalVarianceMs2)}</div>
              <div><b>Blink interval skewness:</b> {formatNumber(sessionSummary.blinkIntervalSkewness, 2)}</div>
              <div><b>Blink regularity index:</b> {formatNumber(sessionSummary.blinkRegularityIndex, 0)}</div>
              <div><b>Final adaptive threshold:</b> {sessionSummary.finalAdaptiveThresholdSec.toFixed(1)}s</div>
              <div><b>Session score:</b> {sessionSummary.score === null ? "N/A" : `${sessionSummary.score}/100`}</div>
              <div><b>Grade:</b> {sessionSummary.grade}</div>
              <div><b>Why:</b> {sessionSummary.gradeReason}</div>
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
          <div style={{ position: "relative", width: 640, height: 480 }}>
            <video
              ref={videoRef}
              muted
              playsInline
              width={640}
              height={480}
              style={{ borderRadius: 10, background: "#111", position: "absolute", inset: 0 }}
            />
            <canvas
              ref={overlayCanvasRef}
              width={640}
              height={480}
              style={{
                position: "absolute",
                inset: 0,
                borderRadius: 10,
                pointerEvents: "none",
                display: devMode ? "block" : "none",
              }}
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
        <div><b>Total blinks:</b> {blinks}</div>
        <div><b>Normal blinks:</b> {normalBlinks}</div>
        <div><b>Micro blinks:</b> {microBlinks}</div>
        <div><b>Blinks / min:</b> {blinksPerMin.toFixed(1)}</div>
        <div><b>Seconds since last blink:</b> {secondsSinceBlink.toFixed(1)}</div>
        <div><b>Adaptive threshold:</b> {adaptiveThresholdSec.toFixed(1)}s</div>
        <div style={{ opacity: 0.75 }}>Tip: if you don’t hear sound, click once on the page (browser audio rule).</div>
      </div>

      {devMode && running && (
        <div
          style={{
            marginTop: 12,
            lineHeight: 1.7,
            background: "#111",
            padding: 12,
            borderRadius: 10,
            border: "1px solid #222",
          }}
        >
          <div><b>Left EAR:</b> {devMetricsRef.current.leftEAR.toFixed(3)}</div>
          <div><b>Right EAR:</b> {devMetricsRef.current.rightEAR.toFixed(3)}</div>
          <div><b>Average EAR:</b> {devMetricsRef.current.avgEAR.toFixed(3)}</div>
          <div><b>Left eyelid distances:</b> {devMetricsRef.current.leftV1.toFixed(1)}, {devMetricsRef.current.leftV2.toFixed(1)}</div>
          <div><b>Right eyelid distances:</b> {devMetricsRef.current.rightV1.toFixed(1)}, {devMetricsRef.current.rightV2.toFixed(1)}</div>
          <div><b>Left eye opening average:</b> {devMetricsRef.current.leftOpenAvg.toFixed(1)} px</div>
          <div><b>Right eye opening average:</b> {devMetricsRef.current.rightOpenAvg.toFixed(1)} px</div>
          <div><b>Left eye width:</b> {devMetricsRef.current.leftH.toFixed(1)}</div>
          <div><b>Right eye width:</b> {devMetricsRef.current.rightH.toFixed(1)}</div>
        </div>
      )}
    </div>
  );
}
