// 对应界面：训练中心

import { jsx } from "../view.js";
import { defineComponent } from "vue";
import {
  API,
  timeLabel,
  metricLabel,
  caseName,
  hubSectionNames,
} from "../shared.js";
import VideoImportButton from "./视频导入按钮.jsx";
import Sidebar from "./侧边导航.jsx";
import HubFeatureView from "./功能页面.jsx";
import ContinueCard from "./当前视频卡片.jsx";

const PlatformHub = defineComponent({
  name: "PlatformHub",
  props: {
    videos: {},
    connection: {},
    importing: {},
    importMessage: {},
    importError: {},
    section: {},
    activeVideo: {},
    session: {},
    result: {},
    health: {},
    onSection: {},
    onExit: {},
    onImport: {},
    onOpen: {},
    onRename: {},
    onDelete: {},
    deletingId: {},
  },
  inheritAttrs: false,
  setup(props) {
    // 页面状态与交互处理。

    // 页面显示内容。
    return () => {
      return (
        <main className="platform-shell">
          <Sidebar
            section={props.section}
            onSection={props.onSection}
            onExit={props.onExit}
          />
          <div className="hub-main">
            <header className="hub-topbar">
              <div>
                <span>羽光智教平台</span>
                <i>/</i>
                <strong>{hubSectionNames[props.section]}</strong>
              </div>
              <div>
                <span className={`connection ${props.connection}`}>
                  <i />
                  {props.connection === "online"
                    ? "本地服务在线"
                    : "本地服务离线"}
                </span>
                <span className="hub-avatar">教练</span>
              </div>
            </header>

            {props.section !== "home" ? (
              <HubFeatureView
                key={`${props.section}-${props.activeVideo?.id ?? "none"}-${props.session.analysis_id ?? "none"}`}
                section={props.section}
                activeVideo={props.activeVideo}
                session={props.session}
                result={props.result}
                health={props.health}
                onOpen={props.onOpen}
              />
            ) : (
              <section className="hub-content">
                <header className="hub-welcome">
                  <div>
                    <span className="section-label">TRAINING WORKSPACE</span>
                    <h1>开始一次训练诊断</h1>
                    {/* <p>
                      当前会话贯穿分析、回放与报告；切换视频会立即清空旧状态。
                    </p> */}
                  </div>
                  <div className="hub-welcome-actions">
                    <VideoImportButton
                      busy={props.importing}
                      disabled={props.connection !== "online"}
                      onImport={props.onImport}
                    />
                    <button
                      className="outline-btn"
                      onClick={() =>
                        props.activeVideo && props.onOpen(props.activeVideo)
                      }
                      disabled={!props.activeVideo}
                    >
                      {props.activeVideo ? "预览" : "暂无视频"}
                    </button>
                  </div>
                </header>
                {(props.importMessage || props.importError) && (
                  <p
                    className={`import-feedback ${props.importError ? "error" : ""}`}
                  >
                    {props.importError ?? props.importMessage}
                  </p>
                )}

                <section className="hub-primary">
                  <ContinueCard
                    activeVideo={props.activeVideo}
                    session={props.session}
                    result={props.result}
                    onOpen={props.onOpen}
                    onRename={props.onRename}
                  />

                  <aside className="workflow-card">
                    <header>
                      <span className="section-label">SESSION STATE</span>
                      <h2>当前会话</h2>
                    </header>
                    <ol>
                      <li className={props.activeVideo ? "done" : ""}>
                        <b>01</b>
                        <div>
                          <strong>选择训练视频</strong>
                        </div>
                        <i>{props.activeVideo ? "✓" : "→"}</i>
                      </li>
                      <li
                        className={props.session.calibration_id ? "done" : ""}
                      >
                        <b>02</b>
                        <div>
                          <strong>标定标准球场</strong>
                        </div>
                        <i>{props.session.calibration_id ? "✓" : "→"}</i>
                      </li>
                      <li className={props.session.job_id ? "done" : ""}>
                        <b>03</b>
                        <div>
                          <strong>执行分析任务</strong>
                        </div>
                        <i>{props.session.job_id ? "✓" : "→"}</i>
                      </li>
                      <li className={props.result ? "done" : ""}>
                        <b>04</b>
                        <div>
                          <strong>生成训练报告</strong>
                        </div>
                        <i>{props.result ? "✓" : "→"}</i>
                      </li>
                    </ol>
                  </aside>
                </section>

                <section className="hub-case-section">
                  <header>
                    <div>
                      <span className="section-label">LOCAL CASES</span>
                      <h2>视频管理</h2>
                    </div>
                    <span>{props.videos.length} 个视频</span>
                  </header>
                  <div className="hub-case-list">
                    {props.videos.map((video, index) => (
                      <article className="hub-case-item" key={video.id}>
                        <button
                          className="hub-case-open"
                          type="button"
                          onClick={() => props.onOpen(video)}
                        >
                          <span className="hub-case-index">
                            {String(index + 1).padStart(2, "0")}
                          </span>
                          <div className="hub-case-thumb">
                            <video
                              src={`${API}/api/videos/${video.id}/stream#t=4`}
                              muted
                              preload="metadata"
                            />
                          </div>
                          <div>
                            <strong>{caseName(video, index)}</strong>
                            <small>
                              {video.width || "—"} × {video.height || "—"} ·{" "}
                              {timeLabel(video.duration)}
                            </small>
                          </div>
                          <span
                            className={
                              video.latest_analysis_id
                                ? "case-state ready"
                                : "case-state"
                            }
                          >
                            {video.latest_analysis_id ? "已有结果" : "待分析"}
                          </span>
                          <i>
                            {props.activeVideo?.id === video.id
                              ? "当前 · 预览"
                              : "预览 →"}
                          </i>
                        </button>
                        <div className="case-actions">
                          <button
                            className="rename-video-btn case-rename-btn"
                            type="button"
                            onClick={() => props.onRename(video)}
                          >
                            重命名
                          </button>
                          <button
                            className="delete-video-btn"
                            type="button"
                            disabled={!!props.deletingId}
                            onClick={() => props.onDelete(video)}
                          >
                            {props.deletingId === video.id ? "删除中…" : "删除"}
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                </section>
              </section>
            )}
          </div>
        </main>
      );
    };
  },
});

export default PlatformHub;
