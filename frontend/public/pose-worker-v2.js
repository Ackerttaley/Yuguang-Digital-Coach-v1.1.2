import { FilesetResolver, PoseLandmarker } from "/vision/vision_bundle.js";

self.import = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error("无法加载姿态运行时");
  (0, eval)(await response.text());
};

let detector;
// 接收视频帧并执行姿态检测。
self.onmessage = async ({ data }) => {
  const { id, type } = data;
  try {
    if (type === "init") {
      const files = await FilesetResolver.forVisionTasks("/vision/wasm");
      detector = await PoseLandmarker.createFromOptions(files, {
        baseOptions: {
          modelAssetPath: "/vision/pose_landmarker_full.task",
          delegate: "CPU",
        },
        runningMode: "VIDEO",
        numPoses: data.multiple ? 2 : 1,
        minPoseDetectionConfidence: 0.65,
        minTrackingConfidence: 0.65,
      });
      self.postMessage({ id });
    } else if (type === "frame") {
      try {
        const result = detector.detectForVideo(data.frame, data.timestamp);
        self.postMessage({ id, landmarks: result.landmarks[0] || [], poses: result.landmarks });
      } finally {
        data.frame.close();
      }
    }
  } catch (error) {
    self.postMessage({ id, error: error.message || String(error) });
  }
};
