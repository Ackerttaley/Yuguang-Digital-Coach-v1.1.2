// 视频加载、定位与 Worker 通信。
function openVideo(url) {
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.src = url;
  return new Promise((resolve, reject) => {
    video.onloadedmetadata = () => resolve(video);
    video.onerror = () => reject(new Error("浏览器无法读取该视频"));
  });
}
function seek(video, time) {
  return new Promise((resolve, reject) => {
    video.onseeked = resolve;
    video.onerror = () => reject(new Error("读取视频帧失败"));
    video.currentTime = Math.min(time, Math.max(0, video.duration - 0.01));
  });
}
function createWorker(url, options, signal) {
  const worker = new Worker(url, options);
  let nextId = 0,
    pending;
  const cancel = () => {
    worker.terminate();
    if (pending) {
      pending.reject(new DOMException("Cancelled", "AbortError"));
      pending = null;
    }
  };
  signal?.addEventListener("abort", cancel, { once: true });
  worker.onmessage = ({ data }) => {
    if (!pending || data.id !== pending.id) return;
    const current = pending;
    pending = null;
    if (data.error) current.reject(new Error(data.error));
    else current.resolve(data);
  };
  worker.onerror = (event) => {
    if (pending) {
      pending.reject(new Error(event.message || "分析线程启动失败"));
      pending = null;
    }
  };
  return {
    call(type, values = {}, transfer = []) {
      if (signal?.aborted)
        return Promise.reject(new DOMException("Cancelled", "AbortError"));
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        pending = { id, resolve, reject };
        worker.postMessage({ id, type, ...values }, transfer);
      });
    },
    close() {
      signal?.removeEventListener("abort", cancel);
      worker.terminate();
    },
  };
}

// 模型选择保存在浏览器本地存储中。
const POSE_MODEL_KEY = "yuguang.pose-model";
const SHUTTLE_MODEL_KEY = "yuguang.shuttle-model";
export const POSE_MODELS = {
  mediapipe: {
    id: "mediapipe",
    label: "MediaPipe BlazePose",
    worker: "/pose-worker-v2.js",
    options: { type: "module" },
    model: "MediaPipe Pose Landmarker",
    version: "web",
    threshold: 0.58,
    sparse: false,
  },
  rtmpose: {
    id: "rtmpose",
    label: "RTMPose-M",
    worker: "/rtmpose-worker.js",
    options: undefined,
    model: "RTMPose-M",
    version: "yolo11n + rtmpose-m_simcc-body7_256x192",
    threshold: 0.5,
    sparse: true,
  },
};
export const SHUTTLE_MODELS = {
  "opencv-motion-v2": {
    id: "opencv-motion-v2",
    label: "OpenCV Motion Tracker v2",
  },
};
function readChoice(key, fallback, allowed) {
  try {
    const value = localStorage.getItem(key);
    return allowed.includes(value) ? value : fallback;
  } catch {
    return fallback;
  }
}
function writeChoice(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 本地存储不可用时仅本次会话生效 */
  }
}
export function getPoseModel() {
  return readChoice(POSE_MODEL_KEY, "mediapipe", Object.keys(POSE_MODELS));
}
export function setPoseModel(id) {
  writeChoice(POSE_MODEL_KEY, id);
}
export function getShuttleModel() {
  return readChoice(
    SHUTTLE_MODEL_KEY,
    "opencv-motion-v2",
    Object.keys(SHUTTLE_MODELS),
  );
}
export function setShuttleModel(id) {
  writeChoice(SHUTTLE_MODEL_KEY, id);
}

// 平滑姿态帧数据。
function smoothFrames(frames) {
  const smoothed = frames.map((frame) => ({
    ...frame,
    landmarks: frame.landmarks.map((point) => ({ ...point })),
  }));
  for (let index = 0; index < smoothed.length; index += 1) {
    const neighbors = [index];
    const previous = smoothed[index - 1],
      next = smoothed[index + 1];
    if (previous && smoothed[index].t - previous.t <= 0.35)
      neighbors.push(index - 1);
    if (next && next.t - smoothed[index].t <= 0.35) neighbors.push(index + 1);
    if (neighbors.length < 2) continue;
    const frame = smoothed[index];
    frame.landmarks.forEach((point, id) => {
      let sumX = 0,
        sumY = 0,
        sumZ = 0,
        sumV = 0;
      neighbors.forEach((offset) => {
        const source = smoothed[offset].landmarks[id];
        sumX += source.x;
        sumY += source.y;
        sumZ += source.z;
        sumV += source.visibility;
      });
      point.x = sumX / neighbors.length;
      point.y = sumY / neighbors.length;
      point.z = sumZ / neighbors.length;
      point.visibility = sumV / neighbors.length;
    });
    const visible = frame.landmarks.filter((point) => point.visibility >= 0.5);
    if (!visible.length) continue;
    const xs = visible.map((point) => point.x),
      ys = visible.map((point) => point.y);
    const left = Math.max(0, Math.min(...xs) - 0.035),
      top = Math.max(0, Math.min(...ys) - 0.055);
    const right = Math.min(1, Math.max(...xs) + 0.035),
      bottom = Math.min(1, Math.max(...ys) + 0.055);
    frame.bbox = { x: left, y: top, w: right - left, h: bottom - top };
    frame.confidence =
      visible.reduce((sum, point) => sum + point.visibility, 0) /
      visible.length;
  }
  return smoothed;
}

// 读取本地或已保存视频的元数据。
export async function readVideoMetadata(file) {
  const url = URL.createObjectURL(file);
  try {
    const video = await openVideo(url);
    return {
      duration: video.duration,
      width: video.videoWidth,
      height: video.videoHeight,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}
export async function readStoredVideoMetadata(videoId) {
  const video = await openVideo(
    `/api/videos/${encodeURIComponent(videoId)}/stream`,
  );
  return {
    duration: video.duration,
    width: video.videoWidth,
    height: video.videoHeight,
  };
}

// 在浏览器中提取人体姿态。
export async function browserPose(videoId, start, duration, sampleFps, signal) {
  const config = POSE_MODELS[getPoseModel()] ?? POSE_MODELS.mediapipe;
  const video = await openVideo(
    `/api/videos/${encodeURIComponent(videoId)}/stream`,
  );
  const worker = createWorker(config.worker, config.options, signal);
  const frames = [];
  let sampled = 0;
  const end = Math.min(start + duration, video.duration);
  let init;
  try {
    init = await worker.call("init");
    for (let time = start; time < end; time += 1 / sampleFps) {
      if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      await seek(video, Math.max(time, 0.001));
      const image = await createImageBitmap(video);
      const result = await worker.call(
        "frame",
        { frame: image, timestamp: Math.round(time * 1000) },
        [image],
      );
      sampled++;
      if (!result.landmarks.length) continue;
      const points = result.landmarks.map((p, id) => ({
        id,
        x: p.x,
        y: p.y,
        z: p.z,
        visibility: p.visibility ?? 0,
      }));
      const visible = points.filter((p) => p.visibility >= 0.5);
      const confidence = Number.isFinite(result.confidence)
        ? result.confidence
        : points.slice(11, 33).reduce((sum, p) => sum + p.visibility, 0) / 22;
      if (
        confidence < config.threshold ||
        visible.length < (config.sparse ? 7 : 12)
      )
        continue;
      const xs = visible.map((p) => p.x),
        ys = visible.map((p) => p.y);
      const left = Math.max(0, Math.min(...xs) - 0.035),
        top = Math.max(0, Math.min(...ys) - 0.055);
      const right = Math.min(1, Math.max(...xs) + 0.035),
        bottom = Math.min(1, Math.max(...ys) + 0.055);
      frames.push({
        t: time,
        confidence,
        bbox: { x: left, y: top, w: right - left, h: bottom - top },
        landmarks: points,
      });
    }
  } finally {
    worker.close();
    video.removeAttribute("src");
    video.load();
  }
  const cleanFrames = smoothFrames(frames);
  const modelName = init?.model ?? config.model;
  const modelVersion = init?.model_version ?? config.version;
  return {
    video_id: videoId,
    model: modelName,
    model_version: modelVersion,
    start,
    end,
    sample_fps: sampleFps,
    frames: cleanFrames,
    sampled_frames: sampled,
    accepted_frames: cleanFrames.length,
    average_confidence: cleanFrames.length
      ? cleanFrames.reduce((sum, frame) => sum + frame.confidence, 0) /
        cleanFrames.length
      : 0,
    failure_reason: cleanFrames.length ? null : "没有检测到符合条件的姿态",
    source: "computed",
    confidence_threshold: config.threshold,
    shuttle_tracking: { enabled: true, model: getShuttleModel() },
  };
}

// 在浏览器中提取羽毛球轨迹。
export async function browserShuttle(
  videoId,
  points,
  start,
  duration,
  onProgress,
  signal,
) {
  const model = getShuttleModel();
  const video = await openVideo(
    `/api/videos/${encodeURIComponent(videoId)}/stream`,
  );
  const worker = createWorker("/shuttle-worker.js", undefined, signal);
  const tracks = [];
  let sampled = 0;
  try {
    await worker.call("init", {
      points,
      width: video.videoWidth,
      height: video.videoHeight,
    });
    for (
      let time = start;
      time < Math.min(start + duration, video.duration);
      time += 0.5
    ) {
      if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      await seek(video, Math.max(time, 0.001));
      const image = await createImageBitmap(video);
      const result = await worker.call("frame", { frame: image, time }, [
        image,
      ]);
      if (result.track && result.track.confidence >= 0.25)
        tracks.push(result.track);
      sampled++;
      onProgress?.(
        Math.min(
          99,
          4 + Math.round((sampled / Math.max(1, duration / 0.5)) * 95),
        ),
      );
    }
  } finally {
    worker.close();
    video.removeAttribute("src");
    video.load();
  }
  return {
    tracks,
    sampled_frames: sampled,
    model,
    model_version: "opencv-js-motion-kalman-2.0",
  };
}

// 在浏览器中分析运动轨迹。
export async function browserMotion(
  videoId,
  points,
  side,
  start,
  duration,
  onProgress,
  signal,
  poseModel = getPoseModel(),
) {
  const video = await openVideo(
    `/api/videos/${encodeURIComponent(videoId)}/stream`,
  );
  const config = POSE_MODELS[poseModel];
  if (!config) throw new Error("所选姿态模型不可用，请重新选择模型。");
  const projection = createWorker("/motion-worker.js", undefined, signal);
  const pose = createWorker(config.worker, config.options, signal);
  const tracks = [];
  let sampled = 0;
  try {
    await projection.call("init", { points, side, width: video.videoWidth, height: video.videoHeight });
    await pose.call("init", { multiple: true });
    for (let time = start; time < Math.min(start + duration, video.duration); time += 0.5) {
      if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      await seek(video, Math.max(time, 0.001));
      const image = await createImageBitmap(video);
      const result = await pose.call("frame", { frame: image, timestamp: Math.round(time * 1000) }, [image]);
      sampled++;
      const candidates = [];
      for (const person of result.poses || []) {
        // 两脚可见时取中点；只有一脚可见时使用该脚。
        // RTMPose 的 COCO 模型只有踝点；MediaPipe 优先使用脚跟及脚尖。
        const indices = poseModel === "rtmpose" ? [27, 28] : [29, 30, 31, 32];
        const feet = indices.map(i => person[i]).filter(p => p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.visibility >= 0.5);
        if (!feet.length) continue;
        const x = feet.reduce((sum, p) => sum + p.x, 0) / feet.length;
        const y = feet.reduce((sum, p) => sum + p.y, 0) / feet.length;
        const mapped = await projection.call("project", { x, y, width: video.videoWidth, height: video.videoHeight });
        if (mapped.x < 0 || mapped.x > 6.1 || mapped.y < 0 || mapped.y > 13.4) continue;
        if (side === "near" ? mapped.y < 6.7 : mapped.y >= 6.7) continue;
        candidates.push({ ...mapped, image_x: x, image_y: y });
      }
      if (candidates.length) {
        const previous = tracks.at(-1);
        candidates.sort((a,b) => previous ? Math.hypot(a.x-previous.x,a.y-previous.y)-Math.hypot(b.x-previous.x,b.y-previous.y) : 0);
        tracks.push({ t: time, x: candidates[0].x, y: candidates[0].y, image_x: candidates[0].image_x, image_y: candidates[0].image_y });
      }
      onProgress(Math.min(78, 8 + Math.round(sampled / Math.max(1, duration / 0.5) * 70)));
    }
  } finally {
    projection.close();
    pose.close();
    video.removeAttribute("src");
    video.load();
  }
  return { tracks, sampled_frames: sampled, pose_model: poseModel };
}

// 从当前视频画面识别场地线框，调用方负责展示并确认候选结果。
export async function detectCourtLines(video) {
  const worker = createWorker("/court-line-worker.js?v=3");
  try {
    const frame = await createImageBitmap(video);
    return await Promise.race([
      worker.call("detect", { frame }, [frame]),
      new Promise((_, reject) => setTimeout(() => reject(new Error("白线识别超时，请换一帧重试。")), 20000)),
    ]);
  } finally {
    worker.close();
  }
}

