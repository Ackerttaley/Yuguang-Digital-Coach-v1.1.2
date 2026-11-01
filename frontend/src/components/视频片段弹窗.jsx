// 对应界面：视频片段弹窗。文字和交互在本文件，外观在同名 CSS 中。

import { jsx, observe } from "../view.js";
import { defineComponent, shallowRef, computed } from "vue";
import {
  API,
  MIN_ANALYSIS_SEGMENT_SECONDS,
  MAX_ANALYSIS_SEGMENT_SECONDS,
  timeLabel,
  normalizeSegment,
} from "../shared.js";

const VideoSegmentSelector = defineComponent({
  name: "VideoSegmentSelector",
  props: {
    video: {},
    initialStart: {},
    initialEnd: {},
    onCancel: {},
    onConfirm: {},
  },
  inheritAttrs: false,
  setup(props) {
    // 页面状态与交互处理。
    const player = shallowRef(null);
    const initialDuration = computed(() =>
      Math.max(0, props.video.duration || 0),
    );
    const initialSegment = computed(() =>
      normalizeSegment(
        initialDuration.value,
        props.initialStart,
        props.initialEnd,
      ),
    );
    const duration = shallowRef(initialDuration.value);
    const currentTime = shallowRef(initialSegment.value.start);
    const segmentStart = shallowRef(initialSegment.value.start);
    const segmentEnd = shallowRef(initialSegment.value.end);

    observe(
      () => {
        const handleEscape = (event) => {
          if (event.key === "Escape") props.onCancel();
        };
        window.addEventListener("keydown", handleEscape);
        return () => window.removeEventListener("keydown", handleEscape);
      },
      () => [props.onCancel],
    );
    function seek(value) {
      const next = Math.max(0, Math.min(value, duration.value));
      if (player.value) player.value.currentTime = next;
      currentTime.value = next;
    }
    const markerMessage = shallowRef("");

    // 直接读取播放器时间，避免 timeupdate 尚未触发时取到旧帧。
    function markCurrentFrame(endpoint) {
      const media = player.value;
      if (!media || media.readyState < 1) return;
      media.pause();
      const frame = media.currentTime;
      const minimum = MIN_ANALYSIS_SEGMENT_SECONDS;
      if (endpoint === "start") {
        if (frame > duration.value - minimum) {
          markerMessage.value = "开始画面后至少需要保留 5 秒。";
          return;
        }
        segmentStart.value = frame;
        segmentEnd.value = Math.min(
          duration.value,
          Math.max(
            frame + minimum,
            Math.min(segmentEnd.value, frame + MAX_ANALYSIS_SEGMENT_SECONDS),
          ),
        );
      } else {
        if (frame < minimum) {
          markerMessage.value = "结束画面前至少需要保留 5 秒。";
          return;
        }
        segmentEnd.value = frame;
        segmentStart.value = Math.max(
          0,
          Math.min(
            frame - minimum,
            Math.max(segmentStart.value, frame - MAX_ANALYSIS_SEGMENT_SECONDS),
          ),
        );
      }
      currentTime.value = frame;
      markerMessage.value = `已将 ${timeLabel(frame, true)} 设为${endpoint === "start" ? "开始" : "结束"}时间`;
    }
    const segmentDuration = computed(() =>
      Math.max(0, segmentEnd.value - segmentStart.value),
    );
    const canConfirm = computed(
      () =>
        duration.value >= MIN_ANALYSIS_SEGMENT_SECONDS &&
        segmentDuration.value >= MIN_ANALYSIS_SEGMENT_SECONDS &&
        segmentDuration.value <= MAX_ANALYSIS_SEGMENT_SECONDS,
    );
    const startPercent = computed(
      () => (segmentStart.value / Math.max(duration.value, 0.001)) * 100,
    );
    const endPercent = computed(
      () => (segmentEnd.value / Math.max(duration.value, 0.001)) * 100,
    );
    const rangeStyle = computed(() => ({
      "--segment-start": `${Math.max(0, Math.min(100, startPercent.value))}%`,
      "--segment-end": `${Math.max(0, Math.min(100, endPercent.value))}%`,
    }));
    const validationMessage = computed(() =>
      duration.value < MIN_ANALYSIS_SEGMENT_SECONDS
        ? "视频不足 5 秒，无法生成分析。"
        : segmentDuration.value < MIN_ANALYSIS_SEGMENT_SECONDS
          ? "分析片段不能短于 5 秒。"
          : segmentDuration.value > MAX_ANALYSIS_SEGMENT_SECONDS
            ? "分析片段不能超过 30 分钟。"
            : "选择的片段最好是同一机位哦！",
    );

    // 页面显示内容。
    return () => {
      return (
        <div className="segment-modal" role="dialog" aria-modal="true">
          <div className="segment-dialog">
            <header>
              <div>
                <span className="section-label">VIDEO PREVIEW</span>
                <h2>预览并选择分析区间</h2>
              </div>
              <button
                className="segment-close"
                type="button"
                onClick={props.onCancel}
                aria-label="关闭区间选择"
              >
                ×
              </button>
            </header>

            <div className="segment-layout">
              <div className="segment-preview">
                <video
                  ref={player}
                  src={`${API}/api/videos/${props.video.id}/stream`}
                  controls
                  playsInline
                  onLoadedMetadata={(event) => {
                    const actualDuration =
                      event.currentTarget.duration || props.video.duration || 0;
                    const normalized = normalizeSegment(
                      actualDuration,
                      segmentStart.value,
                      props.initialEnd === null ? null : segmentEnd.value,
                    );
                    duration.value = actualDuration;
                    segmentStart.value = normalized.start;
                    segmentEnd.value = normalized.end;
                    event.currentTarget.currentTime = normalized.start;
                    currentTime.value = normalized.start;
                  }}
                  onSeeked={(event) =>
                    (currentTime.value = event.currentTarget.currentTime)
                  }
                  onPlay={(event) => {
                    const media = event.currentTarget;
                    if (
                      media.currentTime < segmentStart.value ||
                      media.currentTime >= segmentEnd.value
                    ) {
                      media.currentTime = segmentStart.value;
                    }
                  }}
                  onTimeUpdate={(event) => {
                    const next = event.currentTarget.currentTime;
                    currentTime.value = next;
                    if (
                      !event.currentTarget.paused &&
                      next >= segmentEnd.value
                    ) {
                      event.currentTarget.pause();
                      event.currentTarget.currentTime = segmentEnd.value;
                      currentTime.value = segmentEnd.value;
                    }
                  }}
                />
                <span>
                  当前时间 {timeLabel(currentTime.value, true)} /{" "}
                  {timeLabel(duration.value, true)}
                </span>
              </div>

              <aside className="segment-editor">
                <div className="segment-range-control">
                  <div className="segment-range-endpoints">
                    <span>
                      <small>开始时间</small>
                      <b>{timeLabel(segmentStart.value, true)}</b>
                    </span>
                    <span>
                      <small>结束时间</small>
                      <b>{timeLabel(segmentEnd.value, true)}</b>
                    </span>
                  </div>
                  <div className="dual-range" style={rangeStyle.value}>
                    <div className="dual-range-track" aria-hidden="true">
                      <i />
                    </div>
                    <input
                      className="dual-range-start"
                      aria-label="分析开始时间"
                      aria-valuetext={timeLabel(segmentStart.value, true)}
                      type="range"
                      min="0"
                      max={duration.value}
                      step=".1"
                      value={segmentStart.value}
                      onChange={(event) => {
                        const minimum = Math.max(
                          0,
                          segmentEnd.value - MAX_ANALYSIS_SEGMENT_SECONDS,
                        );
                        const maximum = Math.max(
                          0,
                          segmentEnd.value - MIN_ANALYSIS_SEGMENT_SECONDS,
                        );
                        const value = Math.min(
                          maximum,
                          Math.max(minimum, Number(event.target.value)),
                        );
                        segmentStart.value = value;
                        seek(value);
                      }}
                    />
                    <input
                      className="dual-range-end"
                      aria-label="分析结束时间"
                      aria-valuetext={timeLabel(segmentEnd.value, true)}
                      type="range"
                      min="0"
                      max={duration.value}
                      step=".1"
                      value={segmentEnd.value}
                      onChange={(event) => {
                        const minimum = Math.min(
                          duration.value,
                          segmentStart.value + MIN_ANALYSIS_SEGMENT_SECONDS,
                        );
                        const maximum = Math.min(
                          duration.value,
                          segmentStart.value + MAX_ANALYSIS_SEGMENT_SECONDS,
                        );
                        const value = Math.max(
                          minimum,
                          Math.min(maximum, Number(event.target.value)),
                        );
                        segmentEnd.value = value;
                        seek(value);
                      }}
                    />
                  </div>
                  <div className="segment-range-limits">
                    <span>最短 5 秒</span>
                    <span>最长 30 分钟</span>
                  </div>
                </div>

                <div className="segment-markers">
                  <button
                    type="button"
                    onClick={() => markCurrentFrame("start")}
                  >
                    当前画面设为开始
                  </button>
                  <button type="button" onClick={() => markCurrentFrame("end")}>
                    当前画面设为结束
                  </button>
                </div>
                {markerMessage.value && (
                  <p role="status">{markerMessage.value}</p>
                )}
              </aside>
            </div>

            <footer>
              <span>{validationMessage.value}</span>
              <div>
                <button
                  className="outline-btn"
                  type="button"
                  onClick={props.onCancel}
                >
                  取消
                </button>
                <button
                  className="solid-btn"
                  type="button"
                  disabled={!canConfirm.value}
                  onClick={() =>
                    props.onConfirm(segmentStart.value, segmentEnd.value)
                  }
                >
                  确认区间并进入分析
                </button>
              </div>
            </footer>
          </div>
        </div>
      );
    };
  },
});

export default VideoSegmentSelector;
