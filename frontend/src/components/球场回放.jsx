import { projectCourtGrid } from "../courtProjection.js";
// 2.5D 回放：视频控制时间，球场只展示同一时刻的实际检测点。
import { defineComponent, shallowRef, computed } from "vue";
import { jsx } from "../view.js";
import { API, timeLabel, metricLabel } from "../shared.js";

export default defineComponent({
  name: "CourtReplay",
  props: ["video", "result", "onOpen"],
  setup(props) {
    const player = shallowRef(null);
    const playing = shallowRef(false);
    const tracks = computed(() => (props.result?.tracks || [])
      .filter(p => Number.isFinite(p.t) && Number.isFinite(p.x) && Number.isFinite(p.y))
      .slice().sort((a, b) => a.t - b.t));
    const start = computed(() => props.result?.segment?.start ?? tracks.value[0]?.t ?? 0);
    const end = computed(() => props.result?.segment?.end ?? tracks.value.at(-1)?.t ?? start.value);
    const currentTime = shallowRef(start.value);
    const currentPoint = computed(() => {
      let nearest = null;
      for (const point of tracks.value) {
        if (!nearest || Math.abs(point.t - currentTime.value) < Math.abs(nearest.t - currentTime.value)) nearest = point;
      }
      // 不在检测缺失的时间段伪造球员位置。
      return nearest && Math.abs(nearest.t - currentTime.value) <= 0.3 ? nearest : null;
    });
    const paths = computed(() => {
      const groups = [];
      for (const point of tracks.value) {
        if (point.t > currentTime.value) break;
        const last = groups.at(-1);
        if (!last || point.t - last.at(-1).t > 0.75) groups.push([point]);
        else last.push(point);
      }
      return groups;
    });
    function seek(value) {
      const time = Math.max(start.value, Math.min(end.value, Number(value)));
      currentTime.value = time;
      if (player.value) player.value.currentTime = time;
    }
    function toggle() {
      if (!player.value) return;
      if (playing.value) player.value.pause();
      else {
        if (currentTime.value >= end.value - 0.03) seek(start.value);
        player.value.play().catch(() => { playing.value = false; });
      }
    }
    return () => (
      <section className="hub-content replay-page">
        <header className="replay-heading">
          <div><h1>2.5D 球场回放</h1></div>
          <button className="outline-btn" onClick={() => props.onOpen(props.video)}>重新选择区间</button>
        </header>
        {!["pose-foot-court-2.0", "mediapipe-foot-court-1.1"].includes(props.result?.model_version) && <p className="replay-notice">这是旧版分析结果。请重新识别球场并分析，才能使用脚部定位轨迹。</p>}
        <div className="replay-layout">
          <article className="replay-video-card">
            <h2>视频画面</h2>
            <div className="replay-video-frame">
            <video ref={player} src={`${API}/api/videos/${encodeURIComponent(props.video.id)}/stream`} playsInline preload="metadata"
              onLoadedMetadata={() => seek(start.value)}
              onPlay={() => playing.value = true} onPause={() => playing.value = false}
              onTimeUpdate={event => {
                const video = event.currentTarget;
                currentTime.value = video.currentTime;
                if (video.currentTime >= end.value) { video.pause(); seek(end.value); }
              }} />
              <svg className="replay-video-overlay" viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="视频中的球场线框与脚部检测点">
                {props.result?.calibration?.length === 4 && <g className="replay-video-court">{projectCourtGrid(props.result.calibration).map((line, index) => <line key={index} x1={line[0][0] * 100} y1={line[0][1] * 100} x2={line[1][0] * 100} y2={line[1][1] * 100} />)}</g>}
                {currentPoint.value && Number.isFinite(currentPoint.value.image_x) && Number.isFinite(currentPoint.value.image_y) && <circle className="replay-video-foot" cx={currentPoint.value.image_x * 100} cy={currentPoint.value.image_y * 100} r="0.8" />}
              </svg>
            </div>
            <div className="replay-controls">
              <button className="solid-btn" onClick={toggle}>{playing.value ? "暂停" : "播放"}</button>
              <button className="outline-btn" onClick={() => seek(start.value)}>回到开始</button>
              <span>{timeLabel(currentTime.value, true)} / {timeLabel(end.value, true)}</span>
            </div>
            <input className="replay-timeline" type="range" aria-label="回放进度" min={start.value} max={end.value} step="0.01" value={currentTime.value} onChange={event => seek(event.target.value)} />
          </article>
          <article className="replay-court-card">
            <h2>球场位置</h2>
            <div className="replay-court">
              <svg viewBox="-2 -2 65 138" role="img" aria-label="球员在球场上的检测位置">
                <rect x="0" y="0" width="61" height="134" className="replay-court-floor" />
                {/* 单位为 0.1 米：单打边线、前发球线、双打后发球线及中线。 */}
                <path className="replay-court-lines" d="M 4.6 0 V 134 M 56.4 0 V 134 M 0 7.6 H 61 M 0 47.2 H 61 M 0 86.8 H 61 M 0 126.4 H 61 M 30.5 0 V 47.2 M 30.5 86.8 V 134" />
                {/* 球网位置。 */}
                <line className="replay-court-net" x1="0" y1="67" x2="61" y2="67" />
                {paths.value.map((group, index) => group.length > 1 && <polyline key={index} className="replay-track" points={group.map(p => `${p.x * 10},${p.y * 10}`).join(" ")} />)}
                {currentPoint.value && <circle className="replay-player" cx={currentPoint.value.x * 10} cy={currentPoint.value.y * 10} r="1.8" />}
              </svg>
            </div>
            <p className="replay-position">{currentPoint.value ? `当前位置：X ${metricLabel(currentPoint.value.x, 2)} 米，Y ${metricLabel(currentPoint.value.y, 2)} 米` : "当前时间未检测到球员位置"}</p>
          </article>
        </div>
      </section>
    );
  },
});
