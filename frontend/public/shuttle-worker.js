importScripts("/vision/opencv.js");

// 场地尺寸及跟踪状态。
const COURT = { width: 6.1, height: 13.4 };

let cv, canvas, ctx, matrix, kernel, previous;
let scale = 1;
let tracker = null;

function ready() {
  return new Promise((resolve) => {
    if (typeof self.cv.then === "function")
      self.cv.then((loaded) => resolve({ cv: loaded }));
    else if (self.cv.Mat) resolve({ cv: self.cv });
    else self.cv.onRuntimeInitialized = () => resolve({ cv: self.cv });
  });
}

function project(x, y) {
  const h = matrix.data64F,
    d = h[6] * x + h[7] * y + h[8];
  return [(h[0] * x + h[1] * y + h[2]) / d, (h[3] * x + h[4] * y + h[5]) / d];
}

function insideCourt(point) {
  return (
    point[0] >= -0.6 &&
    point[0] <= COURT.width + 0.6 &&
    point[1] >= -1.2 &&
    point[1] <= COURT.height + 1.2
  );
}

function clampCourt(point) {
  return [
    Math.min(COURT.width, Math.max(0, point[0])),
    Math.min(COURT.height, Math.max(0, point[1])),
  ];
}

function createTracker() {
  return { x: null, y: null, vx: 0, vy: 0, confidence: 0, missing: 0 };
}

function predict(dt) {
  if (!tracker || tracker.x === null) return null;
  return [tracker.x + tracker.vx * dt, tracker.y + tracker.vy * dt];
}

function resetTracker() {
  tracker = createTracker();
}

// 从图像中筛选可能的羽毛球候选点。
function candidates(gray) {
  const found = [];
  const motionMask = new cv.Mat(),
    diff = new cv.Mat(),
    contours = new cv.MatVector(),
    hierarchy = new cv.Mat();
  if (previous) {
    cv.absdiff(previous, gray, diff);
    cv.threshold(diff, motionMask, 22, 255, cv.THRESH_BINARY);
    cv.morphologyEx(motionMask, motionMask, cv.MORPH_CLOSE, kernel);
    cv.findContours(
      motionMask,
      contours,
      hierarchy,
      cv.RETR_EXTERNAL,
      cv.CHAIN_APPROX_SIMPLE,
    );
    for (let i = 0; i < contours.size(); i += 1) {
      const contour = contours.get(i);
      const area = cv.contourArea(contour);
      const rect = cv.boundingRect(contour);
      contour.delete();
      if (area < 140 || area > canvas.width * canvas.height * 0.14) continue;
      const ratio = rect.height / Math.max(1, rect.width);
      if (ratio < 0.35 || ratio > 3.2) continue;
      const pixel = [
        (rect.x + rect.width / 2) / scale,
        (rect.y + rect.height * 0.55) / scale,
      ];
      found.push({
        pixel,
        motion: Math.min(1, area / 1600),
        bright: 0,
        weight: Math.min(1, area / 1600) * 0.8 + (ratio <= 1.8 ? 0.25 : 0),
      });
    }
    diff.delete();
    motionMask.delete();
    contours.delete();
    hierarchy.delete();
    previous.delete();
  }

  const brightMask = new cv.Mat(),
    brightContours = new cv.MatVector(),
    brightHierarchy = new cv.Mat();
  cv.threshold(gray, brightMask, 196, 255, cv.THRESH_BINARY);
  cv.morphologyEx(brightMask, brightMask, cv.MORPH_OPEN, kernel);
  cv.findContours(
    brightMask,
    brightContours,
    brightHierarchy,
    cv.RETR_EXTERNAL,
    cv.CHAIN_APPROX_SIMPLE,
  );
  for (let i = 0; i < brightContours.size(); i += 1) {
    const contour = brightContours.get(i);
    const area = cv.contourArea(contour);
    const rect = cv.boundingRect(contour);
    contour.delete();
    if (area < 60 || area > 2200) continue;
    const ratio = rect.height / Math.max(1, rect.width);
    if (ratio < 0.55 || ratio > 1.85) continue;
    if (rect.width > canvas.width * 0.25 || rect.height > canvas.height * 0.25)
      continue;
    const pixel = [
      (rect.x + rect.width / 2) / scale,
      (rect.y + rect.height / 2) / scale,
    ];
    found.push({
      pixel,
      motion: 0,
      bright: Math.min(1, area / 260),
      weight: Math.min(1, area / 260) * 1.15,
    });
  }
  brightMask.delete();
  brightContours.delete();
  brightHierarchy.delete();
  return found;
}

// 结合跟踪状态选择候选点。
function choose(candidatesList) {
  if (!candidatesList.length) return null;
  const predicted = predict(0.5);
  let best = null,
    bestScore = -Infinity;
  for (const candidate of candidatesList) {
    const court = project(...candidate.pixel);
    if (!insideCourt(court)) continue;
    let score = candidate.weight;
    if (predicted) {
      const distance = Math.hypot(
        court[0] - predicted[0],
        court[1] - predicted[1],
      );
      const gate = 1.4 + (tracker?.missing ?? 0) * 1.4;
      if (distance > gate) continue;
      score += Math.max(0, 1 - distance / gate) * 1.4;
    }
    if (score > bestScore) {
      bestScore = score;
      best = { pixel: candidate.pixel, court, score };
    }
  }
  return best;
}

function report(time) {
  if (!tracker || tracker.x === null) return null;
  const point = clampCourt([tracker.x, tracker.y]);
  return {
    t: time,
    x: point[0],
    y: point[1],
    confidence: Math.min(0.95, Math.max(0.18, tracker.confidence)),
    speed: Math.hypot(tracker.vx, tracker.vy),
    source: tracker.missing > 0 ? "predicted" : "detected",
  };
}

// 处理视频帧并返回羽毛球轨迹。
self.onmessage = async ({ data }) => {
  const { id, type } = data;
  try {
    if (type === "init") {
      ({ cv } = await ready());
      scale = Math.min(1, 720 / data.width);
      canvas = new OffscreenCanvas(
        Math.round(data.width * scale),
        Math.round(data.height * scale),
      );
      ctx = canvas.getContext("2d", { willReadFrequently: true });
      const src = cv.matFromArray(
        4,
        1,
        cv.CV_32FC2,
        data.points.flatMap(([x, y]) => [x * data.width, y * data.height]),
      );
      const dst = cv.matFromArray(4, 1, cv.CV_32FC2, [
        0,
        COURT.height,
        COURT.width,
        COURT.height,
        COURT.width,
        0,
        0,
        0,
      ]);
      matrix = cv.getPerspectiveTransform(src, dst);
      src.delete();
      dst.delete();
      kernel = cv.Mat.ones(5, 5, cv.CV_8U);
      resetTracker();
      self.postMessage({ id });
    } else if (type === "reset") {
      resetTracker();
      previous?.delete();
      previous = null;
      self.postMessage({ id });
    } else if (type === "frame") {
      try {
        ctx.drawImage(data.frame, 0, 0, canvas.width, canvas.height);
        data.frame.close();
        const rgba = cv.matFromImageData(
          ctx.getImageData(0, 0, canvas.width, canvas.height),
        );
        const gray = new cv.Mat();
        cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
        rgba.delete();
        cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
        const best = choose(candidates(gray));
        if (best) {
          const [cx, cy] = best.court;
          if (tracker.x === null) {
            tracker = {
              x: cx,
              y: cy,
              vx: 0,
              vy: 0,
              confidence: 0.5,
              missing: 0,
            };
          } else {
            const residualX = cx - (tracker.x + tracker.vx * 0.5);
            const residualY = cy - (tracker.y + tracker.vy * 0.5);
            tracker.x = tracker.x + tracker.vx * 0.5 + residualX * 0.6;
            tracker.y = tracker.y + tracker.vy * 0.5 + residualY * 0.6;
            tracker.vx = tracker.vx * 0.55 + (residualX / 0.5) * 0.45;
            tracker.vy = tracker.vy * 0.55 + (residualY / 0.5) * 0.45;
            tracker.confidence = Math.min(
              0.95,
              tracker.confidence * 0.75 + 0.25 + Math.min(0.35, best.score / 3),
            );
            tracker.missing = 0;
          }
        } else if (tracker && tracker.x !== null && tracker.missing < 3) {
          tracker.x += tracker.vx * 0.5;
          tracker.y += tracker.vy * 0.5;
          tracker.missing += 1;
          tracker.confidence *= 0.62;
        } else {
          resetTracker();
        }
        previous = gray;
        self.postMessage({ id, track: report(data.time) });
      } catch (error) {
        data.frame?.close();
        throw error;
      }
    }
  } catch (error) {
    data.frame?.close();
    self.postMessage({ id, error: error?.message || String(error) });
  }
};
