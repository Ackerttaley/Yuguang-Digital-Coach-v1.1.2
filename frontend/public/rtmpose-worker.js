importScripts("/ort/v1311/ort.wasm.min.js");

// 模型关键点映射及推理输入参数。
const BLASEPOSE_FROM_COCO = {
  0: 0,
  1: 2,
  2: 5,
  3: 7,
  4: 8,
  5: 11,
  6: 12,
  7: 13,
  8: 14,
  9: 15,
  10: 16,
  11: 23,
  12: 24,
  13: 25,
  14: 26,
  15: 27,
  16: 28,
};
const DETECT_INPUT = 640;
const DETECT_EVERY = 4;
const POSE_INPUT_W = 192;
const POSE_INPUT_H = 256;
const MEAN = [123.675, 116.28, 103.53];
const STD = [58.395, 57.12, 57.375];

let ortRuntime, detector, poseModel, canvas, ctx, detectCanvas, detectCtx;
let multiplePeople = false;
let lastBox = null,
  lastKeypoints = null,
  frameIndex = 0;

// 初始化检测和姿态模型。
async function ready() {
  return new Promise((resolve, reject) => {
    if (self.ort?.InferenceSession) return resolve(self.ort);
    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      if (self.ort?.InferenceSession) {
        clearInterval(timer);
        resolve(self.ort);
      } else if (attempts > 100) {
        clearInterval(timer);
        reject(new Error("无法加载 ONNX Runtime Web"));
      }
    }, 100);
  });
}

function createDetectCanvas() {
  detectCanvas = new OffscreenCanvas(DETECT_INPUT, DETECT_INPUT);
  detectCtx = detectCanvas.getContext("2d", { willReadFrequently: true });
}

function letterbox(width, height) {
  const scale = Math.min(DETECT_INPUT / width, DETECT_INPUT / height);
  const drawW = Math.round(width * scale),
    drawH = Math.round(height * scale);
  const offsetX = (DETECT_INPUT - drawW) / 2,
    offsetY = (DETECT_INPUT - drawH) / 2;
  return { scale, drawW, drawH, offsetX, offsetY };
}

function tensorFromRgba(image) {
  const data = image.data;
  const pixels = image.width * image.height;
  const tensor = new Float32Array(pixels * 3);
  for (let i = 0; i < pixels; i += 1) {
    tensor[i] = data[i * 4] / 255;
    tensor[pixels + i] = data[i * 4 + 1] / 255;
    tensor[pixels * 2 + i] = data[i * 4 + 2] / 255;
  }
  return tensor;
}

function iou(a, b) {
  const x1 = Math.max(a.x1, b.x1),
    y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2),
    y2 = Math.min(a.y2, b.y2);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = (a.x2 - a.x1) * (a.y2 - a.y1);
  const areaB = (b.x2 - b.x1) * (b.y2 - b.y1);
  return inter / (areaA + areaB - inter + 1e-9);
}

function nms(boxes, threshold = 0.45) {
  const sorted = boxes.slice().sort((a, b) => b.score - a.score);
  const kept = [];
  for (const box of sorted) {
    if (kept.every((item) => iou(item, box) < threshold)) kept.push(box);
  }
  return kept;
}

// 检测画面中的人物候选框。
async function detectPersonAsync(frame, multiple = false) {
  const width = frame.width,
    height = frame.height;
  const { scale, drawW, drawH, offsetX, offsetY } = letterbox(width, height);
  detectCtx.fillStyle = "rgb(114,114,114)";
  detectCtx.fillRect(0, 0, DETECT_INPUT, DETECT_INPUT);
  detectCtx.drawImage(
    frame,
    0,
    0,
    width,
    height,
    offsetX,
    offsetY,
    drawW,
    drawH,
  );
  const input = tensorFromRgba(
    detectCtx.getImageData(0, 0, DETECT_INPUT, DETECT_INPUT),
  );
  const feeds = {};
  feeds[detector.inputNames[0]] = new ortRuntime.Tensor("float32", input, [
    1,
    3,
    DETECT_INPUT,
    DETECT_INPUT,
  ]);
  const output = (await detector.run(feeds))[detector.outputNames[0]];
  const anchors = output.dims[2];
  const data = output.data;
  const boxes = [];
  for (let index = 0; index < anchors; index += 1) {
    const score = data[4 * anchors + index];
    if (score < 0.3) continue;
    const cx = data[index],
      cy = data[anchors + index];
    const bw = data[anchors * 2 + index],
      bh = data[anchors * 3 + index];
    const box = {
      x1: (cx - bw / 2 - offsetX) / scale,
      y1: (cy - bh / 2 - offsetY) / scale,
      x2: (cx + bw / 2 - offsetX) / scale,
      y2: (cy + bh / 2 - offsetY) / scale,
      score,
    };
    const area = Math.max(0, box.x2 - box.x1) * Math.max(0, box.y2 - box.y1);
    if (area < width * height * (multiple ? 0.0025 : 0.02)) continue;
    boxes.push({ ...box, area });
  }
  const candidates = nms(boxes).sort(
    (a, b) => b.area * b.score - a.area * a.score,
  );
  const padded = candidates.slice(0, multiple ? 4 : 1).map((best) => {
    const padX = (best.x2 - best.x1) * 0.1;
    const padY = (best.y2 - best.y1) * 0.1;
    return {
      x1: Math.max(0, best.x1 - padX),
      y1: Math.max(0, best.y1 - padY),
      x2: Math.min(width, best.x2 + padX),
      y2: Math.min(height, best.y2 + padY),
      score: best.score,
    };
  });
  return multiple ? padded : (padded[0] ?? null);
}

function cropBox(box, padding = 1.15) {
  const cx = (box.x1 + box.x2) / 2,
    cy = (box.y1 + box.y2) / 2;
  const halfW = Math.max(12, ((box.x2 - box.x1) * padding) / 2);
  const halfH = Math.max(24, ((box.y2 - box.y1) * padding) / 2);
  return { x: cx - halfW, y: cy - halfH, w: halfW * 2, h: halfH * 2 };
}

function normalizeCrop(image) {
  const pixels = POSE_INPUT_W * POSE_INPUT_H;
  const tensor = new Float32Array(pixels * 3);
  const data = image.data;
  for (let i = 0; i < pixels; i += 1) {
    tensor[i] = (data[i * 4] - MEAN[0]) / STD[0];
    tensor[pixels + i] = (data[i * 4 + 1] - MEAN[1]) / STD[1];
    tensor[pixels * 2 + i] = (data[i * 4 + 2] - MEAN[2]) / STD[2];
  }
  return tensor;
}

function pointFromKeypoints(keypoints, width, height) {
  const landmarks = Array.from({ length: 33 }, (_, index) => ({
    id: index,
    x: 0,
    y: 0,
    z: 0,
    visibility: 0,
  }));
  keypoints.forEach((point, cocoIndex) => {
    const target = BLASEPOSE_FROM_COCO[cocoIndex];
    if (target === undefined) return;
    landmarks[target] = {
      id: target,
      x: point.x / width,
      y: point.y / height,
      z: 0,
      visibility: point.visibility,
    };
  });
  const fill = (ids, source) =>
    ids.forEach((id) => {
      landmarks[id] = { ...landmarks[source], id, visibility: 0 };
    });
  fill([1, 3], 2);
  fill([4, 6], 5);
  fill([9, 10], 0);
  fill([17, 18, 19, 20, 21, 22], 15);
  fill([18, 20, 22], 16);
  fill([29, 30, 31, 32], 27);
  fill([30, 32], 28);
  return landmarks;
}

// 裁剪人物区域并估计关键点。
async function estimatePose(frame, selectedBox = null) {
  const width = frame.width,
    height = frame.height;
  if (!selectedBox && (!lastBox || frameIndex % DETECT_EVERY === 0)) {
    const detected = await detectPersonAsync(frame);
    if (detected) lastBox = detected;
  }
  const personBox = selectedBox || lastBox;
  if (!personBox) return { landmarks: [], confidence: 0 };
  const box = cropBox(personBox);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, POSE_INPUT_W, POSE_INPUT_H);
  ctx.drawImage(
    frame,
    box.x,
    box.y,
    box.w,
    box.h,
    0,
    0,
    POSE_INPUT_W,
    POSE_INPUT_H,
  );
  const input = normalizeCrop(
    ctx.getImageData(0, 0, POSE_INPUT_W, POSE_INPUT_H),
  );
  const feeds = {};
  feeds[poseModel.inputNames[0]] = new ortRuntime.Tensor("float32", input, [
    1,
    3,
    POSE_INPUT_H,
    POSE_INPUT_W,
  ]);
  const outputs = await poseModel.run(feeds);
  const simccX = outputs[poseModel.outputNames[0]];
  const simccY = outputs[poseModel.outputNames[1]];
  const binsX = simccX.dims[2],
    binsY = simccY.dims[2];
  const keypoints = [];
  for (let k = 0; k < 17; k += 1) {
    let bestX = 0,
      bestY = 0;
    let maxX = -Infinity,
      maxY = -Infinity;
    for (let index = 0; index < binsX; index += 1) {
      const value = simccX.data[k * binsX + index];
      if (value > maxX) {
        maxX = value;
        bestX = index;
      }
    }
    for (let index = 0; index < binsY; index += 1) {
      const value = simccY.data[k * binsY + index];
      if (value > maxY) {
        maxY = value;
        bestY = index;
      }
    }
    const x = (bestX / 2 / POSE_INPUT_W) * box.w + box.x;
    const y = (bestY / 2 / POSE_INPUT_H) * box.h + box.y;
    keypoints.push({
      x,
      y,
      visibility: Math.max(0, Math.min(1, Math.min(maxX, maxY))),
    });
  }
  lastKeypoints = keypoints;
  const core = [0, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
  const confidence =
    core.reduce((sum, index) => sum + keypoints[index].visibility, 0) /
    core.length;
  return {
    landmarks: pointFromKeypoints(keypoints, width, height),
    confidence,
  };
}

// 处理主线程发送的初始化和推理请求。
self.onmessage = async ({ data }) => {
  const { id, type } = data;
  try {
    if (type === "init") {
      multiplePeople = !!data.multiple;
      ortRuntime = await ready();
      ortRuntime.env.wasm.numThreads = 1;
      ortRuntime.env.wasm.simd = true;
      ortRuntime.env.wasm.wasmPaths = "/ort/v1311/";
      ortRuntime.env.logLevel = "error";
      [detector, poseModel] = await Promise.all([
        ortRuntime.InferenceSession.create("/models/yolo11n.onnx", {
          executionProviders: ["wasm"],
          graphOptimizationLevel: "all",
        }),
        ortRuntime.InferenceSession.create("/models/rtmpose-m.onnx", {
          executionProviders: ["wasm"],
          graphOptimizationLevel: "all",
        }),
      ]);
      canvas = new OffscreenCanvas(POSE_INPUT_W, POSE_INPUT_H);
      ctx = canvas.getContext("2d", { willReadFrequently: true });
      createDetectCanvas();
      self.postMessage({
        id,
        model: "RTMPose-M",
        model_version: "yolo11n + rtmpose-m_simcc-body7_256x192",
      });
    } else if (type === "frame") {
      try {
        frameIndex += 1;
        if (multiplePeople) {
          // 跑位分析需要对多个球员分别估计关键点，再由球场坐标选择近/远端。
          const boxes = await detectPersonAsync(data.frame, true);
          const poses = [];
          for (const box of boxes) {
            const result = await estimatePose(data.frame, box);
            if (result.landmarks.length) poses.push(result.landmarks);
          }
          self.postMessage({ id, poses, landmarks: poses[0] || [], sparse: true });
        } else {
          const result = await estimatePose(data.frame);
          self.postMessage({ id, ...result, sparse: true });
        }
      } finally {
        data.frame.close();
      }
    }
  } catch (error) {
    data.frame?.close();
    self.postMessage({ id, error: error?.message || String(error) });
  }
};
