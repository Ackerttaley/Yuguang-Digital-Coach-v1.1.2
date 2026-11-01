// 将标准球场线投影回视频，用于核对球场映射是否与实际白线重合。
// 标定点顺序：近左、近右、远右、远左；球场坐标范围为 6.1 × 13.4 米。
export function projectCourtGrid(points) {
  if (!Array.isArray(points) || points.length !== 4) return [];
  const [bottomLeft, bottomRight, topRight, topLeft] = points;
  if ([bottomLeft, bottomRight, topRight, topLeft].some(p => !Array.isArray(p) || p.length < 2 || !p.every(Number.isFinite))) return [];
  const [x0, y0] = topLeft, [x1, y1] = topRight, [x2, y2] = bottomRight, [x3, y3] = bottomLeft;
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  const denominator = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(denominator) < 1e-9) return [];
  const g = (dx3 * dy2 - dx2 * dy3) / denominator;
  const h = (dx1 * dy3 - dx3 * dy1) / denominator;
  const a = x1 - x0 + g * x1, b = x3 - x0 + h * x3;
  const d = y1 - y0 + g * y1, e = y3 - y0 + h * y3;
  function project(x, y) {
    const u = x / 6.1, v = y / 13.4, w = g * u + h * v + 1;
    if (Math.abs(w) < 1e-9) return null;
    return [(a * u + b * v + x0) / w, (d * u + e * v + y0) / w];
  }
  // 所有线都按米定义；中间线为球网，其余为发球线、单打边线及中线。
  const lines = [
    [[0,0],[6.1,0]], [[0,13.4],[6.1,13.4]],
    [[0,0],[0,13.4]], [[6.1,0],[6.1,13.4]],
    [[0.46,0],[0.46,13.4]], [[5.64,0],[5.64,13.4]],
    [[0,0.76],[6.1,0.76]], [[0,4.72],[6.1,4.72]],
    [[0,6.7],[6.1,6.7]], [[0,8.68],[6.1,8.68]], [[0,12.64],[6.1,12.64]],
    [[3.05,0],[3.05,4.72]], [[3.05,8.68],[3.05,13.4]],
  ];
  return lines.map(([from,to]) => [project(...from),project(...to)]).filter(line => line.every(p => p && p.every(Number.isFinite)));
}
