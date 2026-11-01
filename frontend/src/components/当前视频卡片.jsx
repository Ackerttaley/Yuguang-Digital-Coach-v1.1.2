import { API, caseName, metricLabel } from "../shared.js";
// 对应界面：当前视频卡片。文字和交互在本文件，外观在同名 CSS 中。

// 训练中心：当前视频、分析指标和“继续”按钮。
import { defineComponent, Fragment } from "vue";
import { jsx } from "../view.js";

export default defineComponent({
  name: "ContinueCard",
  props: ["activeVideo", "session", "result", "onOpen", "onRename"],
  setup(props) {
    // 页面状态与交互处理。
    return () => (
      <article className="continue-card">
        <div className="continue-media">
          {props.activeVideo ? (
            <video
              src={`${API}/api/videos/${props.activeVideo.id}/stream#t=4`}
              muted
              preload="metadata"
            />
          ) : (
            <div />
          )}
          <span className="continue-badge">
            {props.session.status === "ready"
              ? "结果已就绪"
              : props.session.status === "running" ||
                  props.session.status === "queued"
                ? "分析进行中"
                : "待分析"}
          </span>
          <button
            onClick={() => props.activeVideo && props.onOpen(props.activeVideo)}
            disabled={!props.activeVideo}
            aria-label="预览当前视频并选择分析区间"
          >
            ▶
          </button>
        </div>
        <div className="continue-copy">
          <span className="section-label">ACTIVE SESSION</span>
          <div className="current-video-title">
            <h2>
              {props.activeVideo ? caseName(props.activeVideo) : "等待训练视频"}
            </h2>
            {props.activeVideo && (
              <button
                className="rename-video-btn"
                type="button"
                onClick={() => props.onRename(props.activeVideo)}
              >
                重命名
              </button>
            )}
          </div>
          <div className="continue-progress">
            <span>
              <i
                style={{
                  width:
                    props.session.status === "ready"
                      ? "100%"
                      : props.session.status === "running"
                        ? "55%"
                        : "0%",
                }}
              />
            </span>
            <b>
              {props.session.status === "ready"
                ? `数据来源：${props.session.source ?? props.result?.source ?? "computed"}`
                : (props.session.error ?? "等待用户操作")}
            </b>
          </div>
          <dl>
            <div>
              <dt>回中效率</dt>
              <dd>{metricLabel(props.result?.metrics.return_efficiency, 1)}</dd>
            </div>
            <div>
              <dt>场区覆盖</dt>
              <dd>{metricLabel(props.result?.metrics.coverage, 1)}%</dd>
            </div>
            <div>
              <dt>有效轨迹</dt>
              <dd>
                {metricLabel(props.result?.metrics.valid_track_ratio, 1)}%
              </dd>
            </div>
          </dl>
          <button
            className="open-analysis"
            onClick={() => props.activeVideo && props.onOpen(props.activeVideo)}
            disabled={!props.activeVideo}
          >
            继续 →
          </button>
        </div>
      </article>
    );
  },
});
