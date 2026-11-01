importScripts("/vision/opencv.js");

let cv, canvas, ctx, matrix, kernel, previous, last, scale, side;
// 加载运动分析所需资源。
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
// 接收视频帧并返回运动分析结果。
self.onmessage = async ({ data }) => {
  const { id, type } = data;
  try {
    if (type === "init") {
      ({ cv } = await ready());
      scale = Math.min(1, 720 / data.width);
      side = data.side;
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
      const dst = cv.matFromArray(
        4,
        1,
        cv.CV_32FC2,
        [0, 13.4, 6.1, 13.4, 6.1, 0, 0, 0],
      );
      matrix = cv.getPerspectiveTransform(src, dst);
      src.delete();
      dst.delete();
      kernel = cv.Mat.ones(7, 7, cv.CV_8U);
      self.postMessage({ id });
    } else if (type === "project") {
      const [x, y] = project(data.x * data.width, data.y * data.height);
      self.postMessage({ id, x, y });
    } else if (type === "frame") {
      ctx.drawImage(data.frame, 0, 0, canvas.width, canvas.height);
      data.frame.close();
      const rgba = cv.matFromImageData(
        ctx.getImageData(0, 0, canvas.width, canvas.height),
      );
      const gray = new cv.Mat();
      cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
      cv.GaussianBlur(gray, gray, new cv.Size(7, 7), 0);
      rgba.delete();
      let chosen = null,
        confidence = 0.28;
      if (previous) {
        const diff = new cv.Mat(),
          mask = new cv.Mat(),
          contours = new cv.MatVector(),
          hierarchy = new cv.Mat();
        cv.absdiff(previous, gray, diff);
        cv.threshold(diff, mask, 24, 255, cv.THRESH_BINARY);
        cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, kernel);
        cv.findContours(
          mask,
          contours,
          hierarchy,
          cv.RETR_EXTERNAL,
          cv.CHAIN_APPROX_SIMPLE,
        );
        let best = 0;
        for (let i = 0; i < contours.size(); i++) {
          const contour = contours.get(i),
            area = cv.contourArea(contour),
            rect = cv.boundingRect(contour);
          contour.delete();
          if (area < 180 || area > canvas.width * canvas.height * 0.18)
            continue;
          const pixel = [
              (rect.x + rect.width / 2) / scale,
              (rect.y + rect.height) / scale,
            ],
            court = project(...pixel);
          if (
            court[0] < -0.8 ||
            court[0] > 6.9 ||
            court[1] < -1.5 ||
            court[1] > 14.9 ||
            (side === "near" ? court[1] < 6.7 : court[1] >= 6.7)
          )
            continue;
          const score = area * (rect.height >= rect.width ? 1.25 : 0.8);
          if (score > best) {
            best = score;
            chosen = pixel;
            confidence = Math.min(
              0.92,
              0.45 + score / (canvas.width * canvas.height * 0.08),
            );
          }
        }
        diff.delete();
        mask.delete();
        contours.delete();
        hierarchy.delete();
        previous.delete();
      }
      const pixel = chosen || last;
      let track = null;
      if (pixel) {
        const [x, y] = project(...pixel);
        if (x >= -0.8 && x <= 6.9 && y >= -1.5 && y <= 14.9) {
          track = {
            t: data.time,
            x: Math.min(6.1, Math.max(0, x)),
            y: Math.min(13.4, Math.max(0, y)),
            confidence,
          };
          last = pixel;
        }
      }
      previous = gray;
      self.postMessage({ id, track });
    }
  } catch (error) {
    data.frame?.close();
    self.postMessage({ id, error: error.message || String(error) });
  }
};
