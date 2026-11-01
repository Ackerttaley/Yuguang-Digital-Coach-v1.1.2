import { projectCourtGrid } from "../courtProjection.js";
// 对应界面：训练分析。文字和交互在本文件，外观在同名 CSS 中。

import { jsx, observe } from "../view.js";
import { defineComponent, shallowRef, computed } from "vue";
import {
  API,
  calibrationPreset,
  pointLabels,
  MIN_ANALYSIS_SEGMENT_SECONDS,
  MAX_ANALYSIS_SEGMENT_SECONDS,
  timeLabel,
  metricLabel,
  caseName,
  apiJson,
} from "../shared.js";
import {
  browserMotion,
  detectCourtLines,
  browserShuttle,
  getPoseModel,
  getShuttleModel,
} from "../browserVision.js";
import Shuttle from "./羽球图标.jsx";
import Sidebar from "./侧边导航.jsx";
import EmptyState from "./空状态提示.jsx";

const AnalysisView = defineComponent({
  name: "AnalysisView",
  props: {
    video: {},
    session: {},
    result: {},
    onBack: {},
    onNavigate: {},
    onSessionChange: {},
    onAnalysisReady: {},
  },
  inheritAttrs: false,
  setup(props) {
    // 页面状态与交互处理。
    const points = shallowRef([]);
    const detectingCourt = shallowRef(false);
    const detectedCourt = shallowRef(false);
    const side = shallowRef(props.session.player_side);
    const job = shallowRef(null);
    const actionError = shallowRef(null);
    const actionMessage = shallowRef(null);
    const analyzing = shallowRef(false);
    const time = shallowRef(0);
    const duration = shallowRef(props.video.duration);
    const playing = shallowRef(false);
    const playbackRate = shallowRef(1);
    const volume = shallowRef(1);
    const segmentStart = shallowRef(props.session.segment_start);
    const segmentEnd = shallowRef(
      Math.min(
        props.session.segment_end ?? props.video.duration,
        props.session.segment_start + MAX_ANALYSIS_SEGMENT_SECONDS,
      ),
    );

    const showCalibration = shallowRef(true);
    const player = shallowRef(null);
    const videoRatio = shallowRef(props.video.width && props.video.height ? props.video.width / props.video.height : 16 / 9);
    const requestSerial = shallowRef(0);
    observe(
      () => {
        const controller = new AbortController();
        const currentVideoId = props.video.id;
        apiJson(`${API}/api/videos/${currentVideoId}/calibration`, {
          signal: controller.signal,
        })
          .then((calibration) => {
            if (calibration.video_id !== currentVideoId) return;
            if (calibration.source === "existing") {
              points.value = calibration.points;
              side.value = calibration.player_side;
              props.onSessionChange({
                calibration_id: calibration.calibration_id,
                player_side: calibration.player_side,
              });
            }
          })
          .catch((error) => {
            if (!controller.signal.aborted) {
              actionError.value =
                error instanceof Error ? error.message : "读取标定失败";
            }
          });

        // 页面显示内容。
        return () => {
          controller.abort();
          requestSerial.value += 1;
        };
      },
      () => [props.onSessionChange, props.video.id],
    );
    function calibrate(event) {
      if (!showCalibration.value || points.value.length >= 4) return;
      const box = event.currentTarget.parentElement.getBoundingClientRect();
      const point = [
        (event.clientX - box.left) / box.width,
        (event.clientY - box.top) / box.height,
      ];
      points.value = ((current) => [...current, point])(points.value);
      actionError.value = null;
    }
    // 拖动角点时以视频区域为基准，保存归一化坐标。
    function moveCorner(event, index) {
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
      const box = event.currentTarget.parentElement.parentElement.getBoundingClientRect();
      const x = Math.max(-0.1, Math.min(1.1, (event.clientX - box.left) / box.width));
      const y = Math.max(-0.1, Math.min(1.1, (event.clientY - box.top) / box.height));
      points.value = points.value.map((point, i) => i === index ? [x, y] : point);
      actionError.value = null;
    }
    async function findCourt() {
      if (!player.value || player.value.readyState < 2) {
        actionError.value = "请先等待视频画面加载。";
        return;
      }
      player.value.pause();
      detectingCourt.value = true;
      detectedCourt.value = false;
      actionError.value = null;
      actionMessage.value = "正在识别当前画面的白线…";
      try {
        const result = await detectCourtLines(player.value);
        points.value = result.points;
        detectedCourt.value = true;
        showCalibration.value = true;
        actionMessage.value = "请检查黄色线框，必要时拖动角点对齐球场白线。";
      } catch (error) {
        points.value = [];
        actionMessage.value = null;
        actionError.value = error.message || "白线识别失败，请换一帧重试。";
      } finally {
        detectingCourt.value = false;
      }
    }
    async function analyze(forceRecompute) {
      if (points.value.length !== 4) {
        actionError.value =
          "请先自动识别白线并确认场地，或手动选择四个场地角点。";
        showCalibration.value = true;
        return;
      }
      const end = Math.min(
        segmentEnd.value,
        duration.value || props.video.duration,
      );
      const analysisDuration = end - segmentStart.value;
      if (analysisDuration < MIN_ANALYSIS_SEGMENT_SECONDS) {
        actionError.value = "分析区间至少需要 5 秒。";
        return;
      }
      if (analysisDuration > MAX_ANALYSIS_SEGMENT_SECONDS) {
        actionError.value = "分析区间不能超过 30 分钟。";
        return;
      }
      const serial = ++requestSerial.value;
      analyzing.value = true;
      job.value = null;
      actionError.value = null;
      actionMessage.value = forceRecompute
        ? "正在强制重新计算…"
        : "正在查询可用缓存…";
      try {
        const calibration = await apiJson(
          `${API}/api/videos/${props.video.id}/calibration`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              points: points.value,
              player_side: side.value,
            }),
          },
        );
        if (
          serial !== requestSerial.value ||
          calibration.video_id !== props.video.id
        )
          return;
        const selectedPoseModel = getPoseModel();
        actionMessage.value = "正在浏览器中提取球员轨迹…";
        const movement = await browserMotion(
          props.video.id,
          points.value,
          side.value,
          segmentStart.value,
          analysisDuration,
          (progress) =>
            (actionMessage.value = `正在浏览器中提取球员轨迹 · ${progress}%`),
          undefined,
          selectedPoseModel,
        );
        if (serial !== requestSerial.value) return;
        let shuttleTracks = [];
        try {
          actionMessage.value = "正在追踪羽球飞行轨迹…";
          const shuttle = await browserShuttle(
            props.video.id,
            points.value,
            segmentStart.value,
            analysisDuration,
            (progress) =>
              (actionMessage.value = `正在追踪羽球飞行轨迹 · ${progress}%`),
          );
          shuttleTracks = shuttle.tracks;
        } catch (error) {
          if (serial !== requestSerial.value) return;
          actionMessage.value = `羽球追踪已跳过：${error instanceof Error ? error.message : error}`;
        }
        if (serial !== requestSerial.value) return;
        const created = await apiJson(`${API}/api/analyses`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            video_id: props.video.id,
            player_side: side.value,
            calibration_id: calibration.calibration_id,
            start: segmentStart.value,
            duration: end - segmentStart.value,
            force_recompute: forceRecompute,
            tracks: movement.tracks,
            sampled_frames: movement.sampled_frames,
            pose_model: movement.pose_model,
            shuttle_model: getShuttleModel(),
            shuttle_tracks: shuttleTracks,
          }),
        });
        job.value = {
          id: created.job_id,
          video_id: props.video.id,
          status: created.status === "completed" ? "completed" : "queued",
          progress: created.status === "completed" ? 100 : 1,
          message:
            created.status === "completed"
              ? "正在加载缓存结果"
              : `任务已提交，正在分析${side.value === "near" ? "近端" : "远端"}球员`,
          analysis_id: created.analysis_id,
          source: created.source,
          error: null,
        };
        actionMessage.value = null;
        props.onSessionChange({
          calibration_id: calibration.calibration_id,
          job_id: created.job_id,
          analysis_id: created.analysis_id,
          player_side: side.value,
          status: created.status === "completed" ? "loading" : "queued",
          source: created.source,
          segment_start: segmentStart.value,
          segment_end: end,
          error: null,
        });
        let analysisId = created.analysis_id;
        if (!analysisId) {
          for (let attempt = 0; attempt < 600; attempt += 1) {
            await new Promise((resolve) => window.setTimeout(resolve, 1000));
            if (serial !== requestSerial.value) return;
            const next = await apiJson(`${API}/api/jobs/${created.job_id}`);
            if (next.video_id !== props.video.id) {
              throw new Error("任务结果与当前视频不匹配");
            }
            job.value = next;
            props.onSessionChange({
              status: next.status === "completed" ? "loading" : next.status,
              source: next.source,
              error: next.error ?? null,
            });
            if (next.status === "failed") {
              throw new Error(next.error || "分析任务失败");
            }
            if (next.status === "completed") {
              analysisId = next.analysis_id ?? null;
              break;
            }
          }
        }
        if (!analysisId) throw new Error("任务超时，未生成 analysis_id");
        const analysis = await apiJson(`${API}/api/analyses/${analysisId}`);
        if (
          serial !== requestSerial.value ||
          analysis.video_id !== props.video.id ||
          analysis.analysis_id !== analysisId
        ) {
          throw new Error("分析结果归属校验失败");
        }
        props.onAnalysisReady(
          analysis,
          created.job_id,
          created.source,
          calibration.calibration_id,
        );
        showCalibration.value = true;
        actionMessage.value =
          created.source === "cache"
            ? "已加载匹配参数的缓存结果"
            : "分析完成";
      } catch (error) {
        if (serial !== requestSerial.value) return;
        const message =
          error instanceof Error ? error.message : "分析服务连接失败";
        actionError.value = message;
        props.onSessionChange({
          status: "failed",
          error: message,
        });
      } finally {
        if (serial === requestSerial.value) analyzing.value = false;
      }
    }
    function seek(value) {
      const media = player.value;
      if (!media) return;
      media.currentTime = Math.max(
        segmentStart.value,
        Math.min(value, segmentEnd.value),
      );
      time.value = media.currentTime;
    }
    function jumpTo(value) {
      seek(value);
      void player.value?.play();
    }
    const metrics = computed(() =>
      props.result?.video_id === props.video.id
        ? props.result.metrics
        : undefined,
    );
    const tracks = computed(() =>
      props.result?.video_id === props.video.id ? props.result.tracks : [],
    );
    const currentTrack = computed(() =>
      tracks.value.reduce((closest, item) => {
        if (!closest) return item;
        return Math.abs(item.t - time.value) < Math.abs(closest.t - time.value)
          ? item
          : closest;
      }, undefined),
    );
    const courtPolyline = computed(() =>
      tracks.value
        .map(
          (item) =>
            `${32 + (item.x / 6.1) * 256},${25 + (item.y / 13.4) * 390}`,
        )
        .join(" "),
    );
    const shuttleTracks = computed(() =>
      props.result?.video_id === props.video.id
        ? (props.result.shuttle_tracks ?? [])
        : [],
    );
    const currentShuttle = computed(() =>
      shuttleTracks.value.reduce((closest, item) => {
        if (!closest) return item;
        return Math.abs(item.t - time.value) < Math.abs(closest.t - time.value)
          ? item
          : closest;
      }, undefined),
    );
    const shuttlePolyline = computed(() =>
      shuttleTracks.value
        .map(
          (item) =>
            `${32 + (item.x / 6.1) * 256},${25 + (item.y / 13.4) * 390}`,
        )
        .join(" "),
    );
    const miniShuttlePolyline = computed(() =>
      shuttleTracks.value
        .map(
          (item) =>
            `${55 + (item.x / 6.1) * 250},${24 + (item.y / 13.4) * 176}`,
        )
        .join(" "),
    );
    const maxHeat = computed(() =>
      Math.max(1, ...(props.result?.heatmap.flat() ?? [1])),
    );
    return () => {
      return (
        <main className="platform-shell analysis-shell">
          <Sidebar
            section="training"
            onSection={props.onNavigate}
            onExit={props.onBack}
          />
          <div className="hub-main analysis-page">
            <header className="analysis-nav">
              <button className="brand" onClick={props.onBack}>
                <span>
                  <Shuttle />
                </span>
                <strong>羽光智教</strong>
              </button>
              <p>
                训练中心 <i>/</i> {caseName(props.video)}
              </p>
              <div>
                <button
                  className="outline-btn"
                  disabled={analyzing.value}
                  onClick={() => void analyze(false)}
                >
                  使用匹配缓存
                </button>
                <button
                  className="solid-btn"
                  disabled={analyzing.value}
                  onClick={() => void analyze(true)}
                >
                  {analyzing.value ? "分析进行中…" : "强制重算"}
                </button>
                <button
                  className="outline-btn"
                  disabled={!props.result}
                  onClick={() => window.print()}
                >
                  生成报告
                </button>
              </div>
            </header>

            <div className="analysis-content">
              <header className="analysis-heading">
                <div>
                  <span className="section-label">
                    VIDEO / {props.video.id.slice(0, 8).toUpperCase()}
                  </span>
                  <h1>单打训练诊断</h1>
                </div>
                <span className={`status ${props.session.status}`}>
                  <i />
                  {props.result
                    ? "分析完成"
                    : props.session.status === "failed"
                      ? "分析失败"
                      : "待分析"}
                </span>
              </header>

              <section className="analysis-focus">
                <div className="video-panel">
                  <div className="video-stage" style={{ aspectRatio: videoRatio.value }}>
                    <video
                      ref={player}
                      src={`${API}/api/videos/${props.video.id}/stream`}
                      onLoadedMetadata={(event) => {
                        const actualDuration =
                          event.currentTarget.duration || props.video.duration;
                        if (event.currentTarget.videoWidth && event.currentTarget.videoHeight) {
                          videoRatio.value = event.currentTarget.videoWidth / event.currentTarget.videoHeight;
                        }
                        duration.value = actualDuration;
                        segmentEnd.value = Math.min(
                          segmentEnd.value || actualDuration,
                          actualDuration,
                          segmentStart.value + MAX_ANALYSIS_SEGMENT_SECONDS,
                        );
                        event.currentTarget.currentTime = segmentStart.value;
                        time.value = segmentStart.value;
                      }}
                      onSeeking={(event) => {
                        const media = event.currentTarget;
                        const clamped = Math.max(
                          segmentStart.value,
                          Math.min(media.currentTime, segmentEnd.value),
                        );
                        if (Math.abs(clamped - media.currentTime) > 0.01)
                          media.currentTime = clamped;
                      }}
                      onTimeUpdate={(event) => {
                        const media = event.currentTarget;
                        if (
                          media.currentTime >= segmentEnd.value &&
                          !media.paused
                        ) {
                          media.pause();
                          media.currentTime = segmentEnd.value;
                        }
                        time.value = media.currentTime;
                      }}
                      onPlay={(event) => {
                        if (event.currentTarget.currentTime >= segmentEnd.value)
                          event.currentTarget.currentTime = segmentStart.value;
                        playing.value = true;
                      }}
                      onPause={() => (playing.value = false)}
                    />
                    {showCalibration.value && (
                      <div className="calibration" onClick={calibrate}>
                        {points.value.length === 4 && (
                          <svg className="court-detected-overlay" viewBox="-10 -10 120 120" preserveAspectRatio="none" aria-label="自动识别的球场候选线框">
                            <polygon points={points.value.map(point => `${point[0] * 100},${point[1] * 100}`).join(" ")} />
                            {projectCourtGrid(points.value).map((line, index) => <line key={index} x1={line[0][0] * 100} y1={line[0][1] * 100} x2={line[1][0] * 100} y2={line[1][1] * 100} />)}
                          </svg>
                        )}
                        {points.value.map((point, index) => (
                          <span
                            key={index}
                            role="button"
                            aria-label={`拖动调整${pointLabels[index]}`}
                            onClick={(event) => event.stopPropagation()}
                            onPointerdown={(event) => {
                              if (analyzing.value) return;
                              event.stopPropagation();
                              event.currentTarget.setPointerCapture(event.pointerId);
                            }}
                            onPointermove={(event) => moveCorner(event, index)}
                            onPointerup={(event) => {
                              if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
                            }}
                            style={{
                              left: `${((point[0] + 0.1) / 1.2) * 100}%`,
                              top: `${((point[1] + 0.1) / 1.2) * 100}%`,
                            }}
                          >
                            {index + 1}
                          </span>
                        ))}
                        <div>
                          <strong>
                            {detectedCourt.value
                              ? "拖动角点调整球场"
                              : points.value.length < 4
                                ? `点击${pointLabels[points.value.length]}`
                                : "球场标定已完成"}
                          </strong>
                          <small>
                            {points.value.length}/4 · 拖动角点，让黄色场地线尽量与视频白线重合；角点可稍微移出画面
                          </small>
                        </div>
                      </div>
                    )}
                    <b
                      className="time-tag"
                      style={{
                        left: `${Math.max(8, Math.min(92, ((time.value - segmentStart.value) / Math.max(segmentEnd.value - segmentStart.value, 1)) * 100))}%`,
                      }}
                    >
                      {timeLabel(time.value, true)} · 帧{" "}
                      {Math.round(time.value * (props.video.fps || 0))}
                    </b>
                  </div>

                  <div className="player-toolbar">
                    <button
                      onClick={() =>
                        playing.value
                          ? player.value?.pause()
                          : void player.value?.play()
                      }
                    >
                      {playing.value ? "Ⅱ 暂停" : "▶ 播放"}
                    </button>
                    <button onClick={() => seek(time.value - 5)}>−5 秒</button>
                    <button onClick={() => seek(time.value + 5)}>+5 秒</button>
                    <input
                      aria-label="所选片段播放进度"
                      type="range"
                      min={segmentStart.value}
                      max={segmentEnd.value}
                      step=".01"
                      value={Math.max(
                        segmentStart.value,
                        Math.min(time.value, segmentEnd.value),
                      )}
                      onChange={(event) => seek(Number(event.target.value))}
                    />
                    <select
                      aria-label="播放倍速"
                      value={playbackRate.value}
                      onChange={(event) => {
                        const rate = Number(event.target.value);
                        playbackRate.value = rate;
                        if (player.value) player.value.playbackRate = rate;
                      }}
                    >
                      {[0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => (
                        <option key={rate} value={rate}>
                          {rate}×
                        </option>
                      ))}
                    </select>
                    <label>
                      音量
                      <input
                        aria-label="音量"
                        type="range"
                        min="0"
                        max="1"
                        step=".05"
                        value={volume.value}
                        onChange={(event) => {
                          const nextVolume = Number(event.target.value);
                          volume.value = nextVolume;
                          if (player.value) player.value.volume = nextVolume;
                        }}
                      />
                    </label>
                    <button
                      onClick={() => void player.value?.requestFullscreen()}
                    >
                      全屏
                    </button>
                  </div>

                  <div className="analysis-controls">
                    <div>
                      <span>分析球员</span>
                      <button
                        className={side.value === "near" ? "active" : ""}
                        disabled={analyzing.value}
                        onClick={() => (side.value = "near")}
                      >
                        近端球员
                      </button>
                      <button
                        className={side.value === "far" ? "active" : ""}
                        disabled={analyzing.value}
                        onClick={() => (side.value = "far")}
                      >
                        远端球员
                      </button>
                    </div>
                    <button
                      className="outline-btn"
                      disabled={analyzing.value || detectingCourt.value}
                      onClick={() => void findCourt()}
                    >
                      {detectingCourt.value ? "识别中…" : "自动识别白线"}
                    </button>
                    <button
                      className="solid-btn"
                      disabled={analyzing.value || detectingCourt.value}
                      onClick={() => void analyze(false)}
                    >
                      {analyzing.value ? "分析中…" : "开始智能分析"}
                    </button>
                  </div>

                  {(job.value || actionMessage.value || actionError.value) && (
                    <div className={`job ${actionError.value ? "failed" : ""}`}>
                      <div>
                        <strong>
                          {actionError.value ??
                            job.value?.message ??
                            actionMessage.value ??
                            "准备分析"}
                        </strong>
                        <small>
                          {job.value?.source
                            ? `数据来源：${job.value.source}`
                            : "缓存与重新计算状态将明确展示"}
                        </small>
                      </div>
                      <b>{job.value?.progress ?? (props.result ? 100 : 0)}%</b>
                      <i>
                        <span
                          style={{
                            width: `${job.value?.progress ?? (props.result ? 100 : 0)}%`,
                          }}
                        />
                      </i>
                    </div>
                  )}
                </div>

                <aside className="round-panel">

                  <div className="mini-court mini-court-pro">
                    {props.result ? (
                      <svg viewBox="0 0 360 230" role="img">
                        <path
                          className="mini-floor"
                          d="M55 24 L305 24 L340 200 L20 200 Z"
                        />
                        <path
                          className="mini-boundary"
                          d="M55 24 L305 24 L340 200 L20 200 Z M48 64 L312 64 M38 112 L322 112 M28 160 L332 160 M180 24 L180 200"
                        />
                        <polyline
                          className="mini-route-polyline"
                          points={tracks.value
                            .map(
                              (item) =>
                                `${55 + (item.x / 6.1) * 250},${24 + (item.y / 13.4) * 176}`,
                            )
                            .join(" ")}
                        />
                        {shuttleTracks.value.length > 0 && (
                          <polyline
                            className="mini-shuttle-route"
                            points={miniShuttlePolyline.value}
                          />
                        )}
                        {currentShuttle.value && (
                          <circle
                            className="mini-shuttle-dot"
                            cx={55 + (currentShuttle.value.x / 6.1) * 250}
                            cy={24 + (currentShuttle.value.y / 13.4) * 176}
                            r="4"
                          />
                        )}
                        {currentTrack.value && (
                          <circle
                            className="mini-player-dot primary"
                            cx={55 + (currentTrack.value.x / 6.1) * 250}
                            cy={24 + (currentTrack.value.y / 13.4) * 176}
                            r="8"
                          />
                        )}
                      </svg>
                    ) : (
                      <p>完成分析后显示当前视频的真实跑位点。</p>
                    )}
                  </div>

                  <button
                    className="twin-btn"
                    disabled={!props.result}
                    onClick={() => props.onNavigate("twin")}
                  >
                    ▶ 进入 2.5D 数据回放
                  </button>
                </aside>
              </section>

              <section className="overview">
                <h2>本段表现概览</h2>
                <div className="metric-strip">
                  <span>
                    <small>移动距离</small>
                    <b>
                      {metricLabel(metrics.value?.distance, 1)}
                      <em> m</em>
                    </b>
                  </span>
                  <span>
                    <small>场区覆盖</small>
                    <b>
                      {metricLabel(metrics.value?.coverage, 1)}
                      <em>%</em>
                    </b>
                  </span>
                  <span>
                    <small>回中效率</small>
                    <b>{metricLabel(metrics.value?.return_efficiency, 1)}</b>
                  </span>
                  <span>
                    <small>有效轨迹占比</small>
                    <b>
                      {metricLabel(metrics.value?.valid_track_ratio, 1)}
                      <em>%</em>
                    </b>
                  </span>
                </div>
              </section>

              <section className="lower-analysis">
                <article className={`heat-panel ${props.result ? "" : "heat-panel-empty"}`}>
                  <header>
                    <span>
                      <small>SPATIAL ANALYSIS</small>
                      <b>真实热力与移动路径</b>
                    </span>
                    <em>标准单打场地 · 俯视图</em>
                  </header>
                  <div className={`heat-court heat-court-pro ${props.result ? "" : "heat-court-empty"}`}>
                    {props.result ? (
                      <svg viewBox="0 0 320 440" role="img">
                        <rect
                          x="32"
                          y="25"
                          width="256"
                          height="390"
                          rx="3"
                          className="heat-floor"
                        />
                        {props.result.heatmap.flatMap((row, rowIndex) =>
                          row.map((value, columnIndex) => (
                            <rect
                              key={`${rowIndex}-${columnIndex}`}
                              x={32 + (columnIndex * 256) / 6}
                              y={25 + (rowIndex * 390) / 8}
                              width={256 / 6}
                              height={390 / 8}
                              fill="#ff6e63"
                              opacity={(value / maxHeat.value) * 0.72}
                            />
                          )),
                        )}
                        <path
                          className="heat-lines"
                          d="M32 25 H288 V415 H32 Z M52 25 V415 M268 25 V415 M32 82 H288 M32 220 H288 M32 358 H288 M160 25 V415"
                        />
                        <polyline
                          className="heat-route-main"
                          points={courtPolyline.value}
                        />
                        {shuttleTracks.value.length > 0 && (
                          <polyline
                            className="heat-route-shuttle"
                            points={shuttlePolyline.value}
                          />
                        )}
                        {currentShuttle.value && (
                          <circle
                            className="heat-shuttle-dot"
                            cx={32 + (currentShuttle.value.x / 6.1) * 256}
                            cy={25 + (currentShuttle.value.y / 13.4) * 390}
                            r="5"
                          />
                        )}
                      </svg>
                    ) : (
                      <EmptyState title="等待真实轨迹" />
                    )}
                  </div>
                  <div className="heat-explanation">
                    <h3>图例</h3>
                    <div className="heat-legend-list">
                      <div><i className="legend-player" />蓝色虚线：球员移动路径</div>
                      <div><i className="legend-shuttle" />橙色虚线：羽毛球检测路径</div>
                      <div><i className="legend-heat" />红色区域：球员出现较多的区域</div>
                    </div>
                    <p>图中展示所选片段的检测结果。</p>
                  </div>
                </article>

                <article className="advice-panel">
                  <header>
                    <span>
                      <small>RULE EVIDENCE</small>
                      <b>训练建议</b>
                    </span>
                    <em>
                      {props.result
                        ? `${props.result.advice.length} 条建议`
                        : "等待分析"}
                    </em>
                  </header>
                  <div>
                    {props.result ? (
                      props.result.advice.map((item, index) => (
                        <section
                          key={`${item.metric}-${index}`}
                          className="coaching-card"
                        >
                          <span className="advice-index">
                            {String(index + 1).padStart(2, "0")}
                          </span>
                          <div className="advice-body">
                            <div className="advice-title-row">
                              <h3>{item.title}</h3>
                              <button onClick={() => jumpTo(item.evidence_time)}>
                                {timeLabel(item.evidence_time)}
                              </button>
                            </div>
                            <p className="advice-summary">{item.observation}</p>
                            <div className="diagnostic-block prescription-block">
                              <small>具体训练建议</small>
                              <p>{item.action}</p>
                            </div>
                          </div>
                        </section>
                      ))
                    ) : (
                      <EmptyState title="暂无训练建议" />
                    )}
                  </div>
                </article>
              </section>


            </div>
          </div>
        </main>
      );
    };
  },
});

export default AnalysisView;
