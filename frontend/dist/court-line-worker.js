/* 从当前画面中的白色线段估计球场候选框；结果必须由用户核对。 */
importScripts('/vision/opencv.js');

function loadOpenCV() {
  return new Promise((resolve) => {
    if (typeof self.cv.then === 'function') self.cv.then(loaded => resolve({ cv: loaded }));
    else if (self.cv.Mat) resolve({ cv: self.cv });
    else self.cv.onRuntimeInitialized = () => resolve({ cv: self.cv });
  });
}

function intersection(a, b) {
  const d = (a.x1 - a.x2) * (b.y1 - b.y2) - (a.y1 - a.y2) * (b.x1 - b.x2);
  if (Math.abs(d) < 1e-6) return null;
  const p = a.x1 * a.y2 - a.y1 * a.x2;
  const q = b.x1 * b.y2 - b.y1 * b.x2;
  return { x: (p * (b.x1 - b.x2) - (a.x1 - a.x2) * q) / d,
           y: (p * (b.y1 - b.y2) - (a.y1 - a.y2) * q) / d };
}

function xAt(line, y) {
  return line.x1 + (y - line.y1) * (line.x2 - line.x1) / (line.y2 - line.y1);
}

self.onmessage = async ({ data }) => {
  const { id, frame } = data;
  let image, hsv, mask, edges, lines, low, high;
  try {
    const { cv } = await loadOpenCV();
    const width = Math.min(960, frame.width);
    const height = Math.round(frame.height * width / frame.width);
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(frame, 0, 0, width, height);
    frame.close();
    image = cv.matFromImageData(ctx.getImageData(0, 0, width, height));
    hsv = new cv.Mat(); mask = new cv.Mat(); edges = new cv.Mat(); lines = new cv.Mat();
    cv.cvtColor(image, hsv, cv.COLOR_RGBA2RGB);
    cv.cvtColor(hsv, hsv, cv.COLOR_RGB2HSV);
    low = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [0, 0, 155, 0]);
    high = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [180, 105, 255, 255]);
    cv.inRange(hsv, low, high, mask);
    cv.Canny(mask, edges, 50, 150);
    cv.HoughLinesP(edges, lines, 1, Math.PI / 180, 30, width * .045, width * .025);
    const horizontal = [], diagonal = [];
    for (let i = 0; i < lines.rows; i++) {
      const [x1, y1, x2, y2] = Array.from(lines.data32S.slice(i * 4, i * 4 + 4));
      const dx = x2 - x1, dy = y2 - y1, length = Math.hypot(dx, dy);
      const l = { x1, y1, x2, y2, length, y: (y1 + y2) / 2 };
      if (Math.abs(dy) < Math.abs(dx) * .12 && l.y > height * .35 && length > width * .12) horizontal.push(l);
      else if (Math.abs(dy) > height * .04 && Math.abs(dx) > width * .025 && l.y > height * .38) diagonal.push(l);
    }
    const nearLines = horizontal.filter(l => l.y > height * .77).sort((a, b) => b.y - a.y).slice(0, 12);
    const farLines = horizontal.filter(l => l.y > height * .4 && l.y < height * .72).sort((a, b) => b.length - a.length).slice(0, 30);
    let best = null;
    for (const near of nearLines) for (const far of farLines) {
      const left = diagonal.filter(l => xAt(l, near.y) >= -width * .05 && xAt(l, near.y) < width * .48 && xAt(l, far.y) > xAt(l, near.y)).sort((a,b) => b.length - a.length).slice(0, 18);
      const right = diagonal.filter(l => xAt(l, near.y) <= width * 1.05 && xAt(l, near.y) > width * .52 && xAt(l, far.y) < xAt(l, near.y)).sort((a,b) => b.length - a.length).slice(0, 18);
      for (const l of left) for (const r of right) {
        const corners = [intersection(near, l), intersection(near, r), intersection(far, r), intersection(far, l)];
        if (corners.some(p => !p || p.x < 0 || p.x > width || p.y < 0 || p.y > height)) continue;
        const [nl, nr, fr, fl] = corners;
        const nw = nr.x - nl.x, fw = fr.x - fl.x;
        if (nw < width * .4 || fw < width * .08 || fw > nw * .8 || far.y >= near.y - height * .18) continue;
        const centerPenalty = Math.abs((nl.x + nr.x) / 2 - width / 2) / width;
        const score = (l.length + r.length + near.length + far.length) / width - centerPenalty * 3;
        if (!best || score > best.score) best = { score, corners };
      }
    }
    if (!best) throw new Error('未能从当前画面识别出完整场地线框，请换一帧或使用手动标定。');
    self.postMessage({ id, points: best.corners.map(p => [p.x / width, p.y / height]) });
  } catch (error) {
    try { frame.close(); } catch {}
    self.postMessage({ id, error: error.message || '识别球场白线失败' });
  } finally {
    [image, hsv, mask, edges, lines, low, high].forEach(m => m?.delete());
  }
};
