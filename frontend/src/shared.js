import { apiFetch as fetch } from "./api.js";

export const API = "";
// 分析会话的初始状态。
export const emptySession = {
  video_id: null,
  calibration_id: null,
  job_id: null,
  analysis_id: null,
  player_side: "near",
  status: "idle",
  source: null,
  segment_start: 0,
  segment_end: null,
  error: null,
};
export const calibrationPreset = [
  [0.18, 0.88],
  [0.82, 0.88],
  [0.62, 0.22],
  [0.38, 0.22],
];
export const pointLabels = ["近场左角", "近场右角", "远场右角", "远场左角"];
export const poseConnections = [
  [11, 12],
  [11, 13],
  [13, 15],
  [12, 14],
  [14, 16],
  [11, 23],
  [12, 24],
  [23, 24],
  [23, 25],
  [25, 27],
  [24, 26],
  [26, 28],
  [27, 29],
  [29, 31],
  [28, 30],
  [30, 32],
];
export const POSE_WINDOW_SECONDS = 20;
export const POSE_WINDOW_DURATION = 30;
export const MIN_ANALYSIS_SEGMENT_SECONDS = 5;
export const MAX_ANALYSIS_SEGMENT_SECONDS = 30 * 60;
export function timeLabel(value, withFraction = false) {
  if (!Number.isFinite(value) || value < 0) return "—";
  const minute = Math.floor(value / 60);
  const seconds = withFraction
    ? (value % 60).toFixed(2).padStart(5, "0")
    : String(Math.floor(value % 60)).padStart(2, "0");
  return `${minute}:${seconds}`;
}
export function metricLabel(value, digits = 0) {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toFixed(digits)
    : "—";
}
export function normalizeSegment(videoDuration, requestedStart, requestedEnd) {
  const safeDuration = Math.max(0, videoDuration);
  const maxStart = Math.max(0, safeDuration - MIN_ANALYSIS_SEGMENT_SECONDS);
  const start = Math.min(Math.max(0, requestedStart), maxStart);
  const latestEnd = Math.min(
    safeDuration,
    start + MAX_ANALYSIS_SEGMENT_SECONDS,
  );
  const earliestEnd = Math.min(
    safeDuration,
    start + MIN_ANALYSIS_SEGMENT_SECONDS,
  );
  const end = Math.min(
    latestEnd,
    Math.max(earliestEnd, requestedEnd ?? latestEnd),
  );
  return {
    start,
    end,
  };
}
export function caseName(video, index = 0) {
  if (video.display_name) return video.display_name;
  return `单打训练案例 ${video.id.slice(0, 4).toUpperCase() || index + 1}`;
}
export async function apiJson(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) {
    let message = `请求失败（${response.status}）`;
    try {
      const payload = await response.json();
      const detail = payload?.detail;
      const firstIssue = Array.isArray(detail) ? detail[0] : null;
      const loc = firstIssue?.loc
        ?.filter((part) => typeof part === "string")
        .join(".");
      message =
        typeof detail === "string"
          ? detail
          : firstIssue?.msg
            ? `${loc ? `${loc}：` : ""}${firstIssue.msg}`
            : (detail?.message ?? message);
    } catch {
      // 响应不是 JSON 时，保留根据状态生成的提示信息。
    }
    throw new Error(message);
  }
  return response.json();
}
export const hubSectionNames = {
  home: "训练中心",
  training: "训练分析",
  analysis: "姿态分析",
  twin: "2.5D 回放",
  reports: "训练报告",
  models: "模型选择",
};
// 工作台侧边导航。
