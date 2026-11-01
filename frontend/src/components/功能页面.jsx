import CourtReplay from "./球场回放.jsx";
// 姿态分析、2.5D 回放、训练报告和模型选择；按 props.section 切换。

import { Fragment, defineComponent, shallowRef } from "vue";
import { jsx, observe } from "../view.js";
import {
  API,
  poseConnections,
  POSE_WINDOW_SECONDS,
  POSE_WINDOW_DURATION,
  timeLabel,
  metricLabel,
  caseName,
} from "../shared.js";
import {
  browserPose,
  getPoseModel,
  setPoseModel,
  getShuttleModel,
  setShuttleModel,
} from "../browserVision.js";
import EmptyState from "./空状态提示.jsx";

const HubFeatureView = defineComponent({
  name: "HubFeatureView",
  props: {
    section: {},
    activeVideo: {},
    session: {},
    result: {},
    health: {},
    onOpen: {},
  },
  inheritAttrs: false,
  setup(props) {
    // 页面状态与交互处理。
    const poseModel = shallowRef(getPoseModel());
    const shuttleModel = shallowRef(getShuttleModel());
    const selectPoseModel = (id) => {
      setPoseModel(id);
      poseModel.value = id;
    };
    const selectShuttleModel = (id) => {
      setShuttleModel(id);
      shuttleModel.value = id;
    };
    const poseAvailable = (id) =>
      props.health?.pose_models?.find((model) => model.id === id)?.available ??
      (id === "mediapipe" ? !!props.health?.pose_available : false);
    const shuttleAvailable = (id) =>
      props.health?.shuttle_models?.find((model) => model.id === id)
        ?.available ?? id === "opencv-motion-v2";
    const poseData = shallowRef(null);
    const poseStatus = shallowRef("idle");
    const poseError = shallowRef(null);
    const poseRequest = shallowRef({
      token: 0,
      force: false,
    });

    const poseTime = shallowRef(props.session.segment_start);
    const poseWindowStart = shallowRef(props.session.segment_start);
    const poseVideoRef = shallowRef(null);

    observe(
      () => {
        if (props.section !== "analysis" || !props.activeVideo) return;
        const controller = new AbortController();
        let beginTimer = 0;
        const requestedVideoId = props.activeVideo.id;
        const start = Math.max(
          props.session.segment_start,
          poseWindowStart.value,
        );
        const availableDuration = Math.max(
          2,
          Math.min(
            POSE_WINDOW_DURATION,
            (props.session.segment_end ?? props.activeVideo.duration) - start,
          ),
        );
        const query = new URLSearchParams({
          start: String(start),
          duration: String(availableDuration),
          sample_fps: "6",
          player_side: props.session.player_side,
          force_recompute: String(poseRequest.value.force),
        });
        beginTimer = window.setTimeout(() => {
          poseData.value = null;
          poseError.value = null;
          poseStatus.value = "loading";
          browserPose(
            requestedVideoId,
            start,
            availableDuration,
            6,
            controller.signal,
          )
            .then((payload) => {
              if (payload.video_id !== requestedVideoId) {
                throw new Error("姿态结果与当前视频不匹配");
              }
              poseData.value = payload;
              poseStatus.value = payload.frames.length
                ? "ready"
                : "low-confidence";
            })
            .catch((error) => {
              if (controller.signal.aborted) return;
              poseStatus.value = "error";
              poseError.value =
                error instanceof Error ? error.message : "姿态服务异常";
            });
        }, 0);

        // 页面显示内容。
        return () => {
          window.clearTimeout(beginTimer);
          controller.abort();
        };
      },
      () => [
        props.activeVideo,
        poseModel.value,
        poseRequest.value,
        props.section,
        props.session.player_side,
        props.session.segment_end,
        props.session.segment_start,
        poseWindowStart.value,
      ],
    );
    return () => {
      // ── 训练分析入口 ──
      if (props.section === "training") {
        return (
          <section className="hub-content hub-feature">
            <header className="feature-heading">
              <div>
                <span className="section-label">TRAINING ANALYSIS</span>
                <h1>训练分析</h1>
              </div>
            </header>
            <EmptyState
              title="尚未选择训练视频"
              detail="请先到训练中心选择视频和分析区间。"
            />
          </section>
        );
      }

      // ── 人体姿态分析 ──
      if (props.section === "analysis") {
        if (!props.activeVideo) {
          return (
            <section className="hub-content hub-feature">
              <EmptyState
                title="尚未选择视频"
                detail="请先从训练中心选择一个本地视频。"
              />
            </section>
          );
        }
        const poseFrame = poseData.value?.frames.reduce((closest, item) => {
          if (!closest) return item;
          return Math.abs(item.t - poseTime.value) <
            Math.abs(closest.t - poseTime.value)
            ? item
            : closest;
        }, null);
        const alignedPose =
          poseFrame && Math.abs(poseFrame.t - poseTime.value) <= 0.35
            ? poseFrame
            : null;
        return (
          <section className="hub-content hub-feature analysis-workspace">
            <header className="feature-heading">
              <div>
                <span className="section-label">REAL POSE PIPELINE</span>
                <h1>姿态分析实验室</h1>
                <p>
                  显示姿态采样帧、有效帧与分析状态。
                </p>
              </div>
              <button
                className="solid-btn"
                disabled={poseStatus.value === "loading"}
                onClick={() =>
                  (poseRequest.value = ((value) => ({
                    token: value.token + 1,
                    force: true,
                  }))(poseRequest.value))
                }
              >
                {poseStatus.value === "loading" ? "正在推理…" : "强制重新推理"}
              </button>
            </header>
            <div className="analysis-lab-grid">
              <article className="vision-console">
                <header>
                  <span>
                    <i />
                    {caseName(props.activeVideo)}
                  </span>
                  <b>{poseData.value?.source === "cache" ? "缓存" : "实时"}</b>
                </header>
                <div className="vision-feed">
                  <video
                    ref={poseVideoRef}
                    src={`${API}/api/videos/${props.activeVideo.id}/stream`}
                    muted
                    controls
                    playsInline
                    onLoadedMetadata={(event) => {
                      event.currentTarget.currentTime =
                        poseData.value?.start ?? props.session.segment_start;
                    }}
                    onTimeUpdate={(event) => {
                      const nextTime = event.currentTarget.currentTime;
                      poseTime.value = nextTime;
                      const segmentEnd =
                        props.session.segment_end ?? props.activeVideo.duration;
                      const boundedTime = Math.max(
                        props.session.segment_start,
                        Math.min(
                          nextTime,
                          Math.max(
                            props.session.segment_start,
                            segmentEnd - 0.001,
                          ),
                        ),
                      );
                      const nextWindowStart =
                        props.session.segment_start +
                        Math.floor(
                          (boundedTime - props.session.segment_start) /
                            POSE_WINDOW_SECONDS,
                        ) *
                          POSE_WINDOW_SECONDS;
                      poseWindowStart.value = ((current) =>
                        Math.abs(current - nextWindowStart) < 0.001
                          ? current
                          : nextWindowStart)(poseWindowStart.value);
                    }}
                  />
                  {alignedPose && (
                    <>
                      <span
                        className="detect-box real-pose-box"
                        style={{
                          left: `${alignedPose.bbox.x * 100}%`,
                          top: `${alignedPose.bbox.y * 100}%`,
                          width: `${alignedPose.bbox.w * 100}%`,
                          height: `${alignedPose.bbox.h * 100}%`,
                        }}
                      >
                        <b>BLAZEPOSE · REAL</b>
                      </span>
                      <svg
                        className="real-pose-svg"
                        viewBox="0 0 1 1"
                        preserveAspectRatio="none"
                        aria-label="与当前视频时间对齐的真实姿态关键点"
                      >
                        {poseConnections.map(([from, to]) => {
                          const a = alignedPose.landmarks[from];
                          const b = alignedPose.landmarks[to];
                          if (
                            !a ||
                            !b ||
                            a.visibility < 0.5 ||
                            b.visibility < 0.5
                          ) {
                            return null;
                          }
                          return (
                            <line
                              key={`${from}-${to}`}
                              x1={a.x}
                              y1={a.y}
                              x2={b.x}
                              y2={b.y}
                              vectorEffect="non-scaling-stroke"
                            />
                          );
                        })}
                        {alignedPose.landmarks
                          .slice(11, 33)
                          .map((point) =>
                            point.visibility >= 0.5 ? (
                              <circle
                                key={point.id}
                                cx={point.x}
                                cy={point.y}
                                r=".0065"
                                vectorEffect="non-scaling-stroke"
                              />
                            ) : null,
                          )}
                      </svg>
                    </>
                  )}
                </div>
                <footer>
                  <span>{timeLabel(poseData.value?.start ?? 0, true)}</span>
                  <i>
                    <b
                      style={{
                        width: `${poseData.value?.sampled_frames ? (poseData.value.accepted_frames / poseData.value.sampled_frames) * 100 : 0}%`,
                      }}
                    />
                  </i>
                  <span>{timeLabel(poseData.value?.end ?? 0, true)}</span>
                </footer>
              </article>
              <aside className="pipeline-panel">
                <header>
                  <span>POSE OBSERVABILITY</span>
                  <b>{poseStatus.value.toUpperCase()}</b>
                </header>
                <div className="live-tensors">
                  <span>
                    <small>采样帧</small>
                    <b>{poseData.value?.sampled_frames ?? "—"}</b>
                  </span>
                  <span>
                    <small>有效帧</small>
                    <b>{poseData.value?.accepted_frames ?? "—"}</b>
                  </span>

                  <span>
                    <small>数据来源</small>
                    <b>{poseData.value?.source ?? "—"}</b>
                  </span>
                </div>
                <div
                  className={`pose-runtime pose-runtime-panel ${poseStatus.value}`}
                >
                  <i />
                  {poseStatus.value === "loading"
                    ? `正在分析 ${timeLabel(poseWindowStart.value, true)} 起的片段…`
                    : poseStatus.value === "ready"
                      ? `${poseData.value?.model} · ${poseData.value?.accepted_frames}/${poseData.value?.sampled_frames} 有效帧`
                      : poseStatus.value === "low-confidence"
                        ? poseData.value?.failure_reason
                        : poseStatus.value === "error"
                          ? `姿态服务异常：${poseError.value}`
                          : "等待姿态分析"}
                </div>
                <p className="runtime-note">
                  {props.health?.pose_available
                    ? `姿态服务可用 · ${poseData.value?.model ?? "MediaPipe"} ${poseData.value?.model_version ?? ""}`
                    : `姿态服务不可用 · ${props.health?.pose_error ?? "后端未连接"}`}
                </p>
                <button
                  className="outline-btn"
                  onClick={() => props.onOpen(props.activeVideo)}
                >
                  重新选择分析区间 →
                </button>
              </aside>
            </div>
          </section>
        );
      }

      // 2.5D 回放由独立组件管理视频时间和球场轨迹。
      if (props.section === "twin") {
        if (!props.activeVideo || !props.result || props.result.video_id !== props.activeVideo.id) {
          return <section className="hub-content"><EmptyState title="当前视频尚无回放结果" detail="请先选择视频并完成分析。" action={props.activeVideo ? <button className="solid-btn" onClick={() => props.onOpen(props.activeVideo)}>去分析当前视频</button> : null} /></section>;
        }
        return <CourtReplay key={props.result.analysis_id} video={props.activeVideo} result={props.result} onOpen={props.onOpen} />;
      }

      // ── 训练报告 ──
      if (props.section === "reports") {
        if (
          !props.activeVideo ||
          !props.result ||
          props.result.video_id !== props.activeVideo.id
        ) {
          return (
            <section className="hub-content hub-feature report-workspace">
              <header className="feature-heading">
                <div>
                  <span className="section-label">EVIDENCE REPORT</span>
                  <h1>训练诊断与建议</h1>
                </div>
              </header>
              <EmptyState
                title="没有当前视频的报告"
                detail="完成分析后显示训练报告。"
              />
            </section>
          );
        }
        return (
          <section className="hub-content hub-feature report-workspace">
            <header className="feature-heading">
              <div>
                <span className="section-label">EVIDENCE REPORT</span>
                <h1>训练诊断与建议</h1>
                <p>
                  {caseName(props.activeVideo)} ·
                  所有建议绑定规则、阈值和证据时间戳。
                </p>
              </div>
              <button className="solid-btn" onClick={() => window.print()}>
                打印当前报告
              </button>
            </header>
            <div className="report-score-row">
              <span>
                <small>回中效率</small>
                <b>{metricLabel(props.result.metrics.return_efficiency, 1)}</b>
                <em>分</em>
              </span>
              <span>
                <small>场区覆盖</small>
                <b>{metricLabel(props.result.metrics.coverage, 1)}%</b>
                <em>标准网格</em>
              </span>
              <span>
                <small>移动距离</small>
                <b>{metricLabel(props.result.metrics.distance, 1)}m</b>
                <em>有效步长累计</em>
              </span>
              <span>
                <small>有效轨迹</small>
                <b>{metricLabel(props.result.metrics.valid_track_ratio, 1)}%</b>
                <em>非姿态评分</em>
              </span>
            </div>
            <article className="recommendation-list report-recommendations">
              <header>
                <span>规则训练建议</span>
              </header>
              {props.result.advice.map((item, index) => (
                <section key={`${item.metric}-${index}`}>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <div>
                    <h3>{item.title}</h3>
                    <p>{item.observation}</p>
                    <p>{item.action}</p>
                  </div>
                </section>
              ))}
            </article>
          </section>
        );
      }
      return (
        <section className="hub-content hub-feature model-workspace">
          <header className="feature-heading">
            <div>
              <span className="section-label">MODEL SELECTION</span>
              <h1>模型选择</h1>
              <p>人体姿态模型单选；羽球追踪模型可与姿态模型同时运行。</p>
            </div>
            <span
              className={`all-systems ${props.health?.status === "ok" ? "" : "error"}`}
            >
              <i />{" "}
              {props.health?.status === "ok"
                ? "LOCAL API READY"
                : "API OFFLINE"}
            </span>
          </header>
          <section className="model-role">
            <header>
              <div>
                <span>POSE MODEL</span>
                <h2>人体姿态模型</h2>
              </div>
              <b>当前仅可使用 1 个</b>
            </header>
            <div className="model-choice-grid">
              <article
                className={`model-choice-card actionable ${poseModel.value === "mediapipe" ? "selected" : ""}`}
                onClick={() =>
                  poseAvailable("mediapipe") && selectPoseModel("mediapipe")
                }
              >
                <header>
                  <span>MediaPipe</span>
                  <i
                    className={
                      poseAvailable("mediapipe") ? "available" : "planned"
                    }
                  >
                    {poseAvailable("mediapipe") ? "可用" : "不可用"}
                  </i>
                </header>
                <h3>MediaPipe BlazePose</h3>
                <p>33 关键点全身姿态，浏览器内 WebAssembly 推理。</p>
                <footer>
                  <small>
                    {poseModel.value === "mediapipe"
                      ? "当前姿态模型"
                      : "点击切换"}
                  </small>
                  <button disabled={!poseAvailable("mediapipe")}>
                    {poseModel.value === "mediapipe"
                      ? "✓ 当前使用"
                      : "切换到此模型"}
                  </button>
                </footer>
              </article>
              <article
                className={`model-choice-card actionable ${poseModel.value === "rtmpose" ? "selected" : ""}`}
                onClick={() =>
                  poseAvailable("rtmpose") && selectPoseModel("rtmpose")
                }
              >
                <header>
                  <span>MMPose</span>
                  <i
                    className={
                      poseAvailable("rtmpose") ? "available" : "planned"
                    }
                  >
                    {poseAvailable("rtmpose") ? "新接入" : "不可用"}
                  </i>
                </header>
                <h3>RTMPose-M</h3>
                <p>
                  YOLO11n 人体检测 + RTMPose-m 关键点，ONNX Runtime Web 推理。
                </p>
                <footer>
                  <small>
                    {poseAvailable("rtmpose")
                      ? "yolo11n + rtmpose-m · 256×192"
                      : "缺少 ONNX 模型文件"}
                  </small>
                  <button disabled={!poseAvailable("rtmpose")}>
                    {poseModel.value === "rtmpose"
                      ? "✓ 当前使用"
                      : "切换到此模型"}
                  </button>
                </footer>
              </article>
              <article className="model-choice-card planned">
                <header>
                  <span>MMPose</span>
                  <i className="planned">后续版本</i>
                </header>
                <h3>DWPose</h3>
                <p>全身关键点姿态模型预留入口。</p>
                <footer>
                  <small>尚未接入</small>
                  <button disabled>后续版本</button>
                </footer>
              </article>
            </div>
          </section>

          <section className="model-role">
            <header>
              <div>
                <span>SHUTTLE TRACKING</span>
                <h2>羽球追踪模型</h2>
              </div>
              <b>后续可与姿态模型并存</b>
            </header>
            <div className="model-choice-grid compact">
              <article className="model-choice-card planned">
                <header>
                  <span>TrackNet</span>
                  <i className="planned">后续版本</i>
                </header>
                <h3>TrackNetV3</h3>
                <p>
                  羽毛球检测与飞行轨迹模型预留入口（缺少可离线分发的权重）。
                </p>
                <footer>
                  <small>尚未接入</small>
                  <button disabled>后续版本</button>
                </footer>
              </article>
              <article
                className={`model-choice-card actionable ${shuttleModel.value === "opencv-motion-v2" ? "selected" : ""} support-model`}
                onClick={() =>
                  shuttleAvailable("opencv-motion-v2") &&
                  selectShuttleModel("opencv-motion-v2")
                }
              >
                <header>
                  <span>OpenCV</span>
                  <i className="available">运行中</i>
                </header>
                <h3>OpenCV Motion Tracker v2</h3>
                <p>
                  亮度与运动融合检测 + Kalman 轨迹预测，输出球场坐标飞行轨迹。
                </p>
                <footer>
                  <small>opencv-js-motion-kalman-2.0</small>
                  <button disabled={!shuttleAvailable("opencv-motion-v2")}>
                    {shuttleModel.value === "opencv-motion-v2"
                      ? "✓ 已启用"
                      : "启用此模型"}
                  </button>
                </footer>
              </article>
            </div>
          </section>

          <p className="model-coexistence-note">
            姿态模型与羽球追踪模型的选择会保存在本机，并直接驱动下一轮姿态分析和训练分析。
          </p>
        </section>
      );
    };
  },
});

export default HubFeatureView;
