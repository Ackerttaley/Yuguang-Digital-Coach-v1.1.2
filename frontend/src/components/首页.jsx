// 对应界面：首页。文字和交互在本文件，外观在同名 CSS 中。

import { jsx } from "../view.js";
import { defineComponent } from "vue";
import { API, timeLabel, caseName } from "../shared.js";
import Shuttle from "./羽球图标.jsx";
import VideoImportButton from "./视频导入按钮.jsx";

const Landing = defineComponent({
  name: "Landing",
  props: {
    videos: {},
    connection: {},
    importing: {},
    importMessage: {},
    importError: {},
    onRetry: {},
    onImport: {},
    onOpen: {},
    onEnter: {},
  },
  inheritAttrs: false,
  setup(props) {
    // 页面状态与交互处理。

    // 页面显示内容。
    return () => {
      return (
        <main className="landing">
          <header className="top-nav">
            <button
              className="brand"
              onClick={() =>
                window.scrollTo({
                  top: 0,
                  behavior: "smooth",
                })
              }
            >
              <span>
                <Shuttle />
              </span>
              <strong>羽光智教</strong>
            </button>
            <span className="team-byline">暨南大学“羽光智教”团队出品</span>
            <nav>
              <a href="#home">首页</a>
              <a href="#advantages">智能分析</a>
              <a href="#cases">训练案例</a>
            </nav>
            <button className="primary-pill" onClick={props.onEnter}>
              进入平台 ↗
            </button>
          </header>

          <section className="hero" id="home">
            <div className="hero-title">
              <span className="eyebrow">
                <i /> LOCAL BADMINTON INTELLIGENCE <i />
              </span>
              <h1>
                让每一次挥拍，<em>都有答案</em>
              </h1>
              <p>基于本地视频证据的羽毛球 2.5D 训练数据回放与教练辅助平台</p>
            </div>
            <div
              className="hero-motion hero-animation"
              aria-label="羽毛球训练能力界面示意"
            >
              <img
                className="hero-photo"
                src="/badminton-sunset-hero.png"
                alt="运动员在夕阳下进行羽毛球训练"
              />
            </div>
          </section>

          <section className="intro" id="advantages">
            <span className="section-label">WHY YUGUANG</span>
            <h2>
              从训练视频中，<em>看见动作与跑位</em>
            </h2>
            <p>
              面向羽毛球单打训练，提供姿态分析、场区跑位回放与训练报告，帮助教练和学员高效复盘每一次训练。
            </p>
          </section>

          <section className="story pose-story">
            <span className="story-index">01</span>
            <div className="story-copy">
              <span className="section-label">TRACEABLE ANALYSIS</span>
              <h3>视频姿态与跑位分析</h3>
              <p>
                从训练视频中识别人体关键点与场区移动信息，将动作片段、跑位轨迹和训练建议集中呈现。
              </p>
              <div className="story-facts">
                <span>
                  <b>33</b>人体关键点
                </span>
                <span>
                  <b>LOCAL</b>本机处理
                </span>
                <span>
                  <b>0</b>网络上传
                </span>
              </div>
            </div>
            <div className="pose-art">
              <img
                src="/young-badminton-pexels.jpg"
                alt="青年学生在室内进行羽毛球训练"
              />
              <div className="pose-photo-shade" />
            </div>
          </section>

          <section className="cases" id="cases">
            <header>
              <div>
                <span className="section-label">LOCAL CASE LIBRARY</span>
                <h2>选择训练视频</h2>
              </div>
              <div className="case-actions">
                <VideoImportButton
                  busy={props.importing}
                  disabled={props.connection !== "online"}
                  onImport={props.onImport}
                />
                <span className={`connection ${props.connection}`}>
                  <i />
                  {props.connection === "online"
                    ? "本地分析服务已连接"
                    : props.connection === "loading"
                      ? "正在读取本地视频"
                      : "本地服务未连接"}
                </span>
              </div>
            </header>
            {(props.importMessage || props.importError) && (
              <p
                className={`import-feedback ${props.importError ? "error" : ""}`}
              >
                {props.importError ?? props.importMessage}
              </p>
            )}
            {props.connection === "offline" ? (
              <div className="offline">
                <div>
                  <strong>等待本地分析服务</strong>
                  <p>启动平台后会自动读取 video 文件夹。</p>
                </div>
                <button onClick={props.onRetry}>重新连接</button>
              </div>
            ) : props.videos.length ? (
              <div className="case-grid">
                {props.videos.map((video, index) => (
                  <button
                    className="case-card"
                    key={video.id}
                    onClick={() => props.onOpen(video)}
                  >
                    <div className="case-image">
                      <video
                        src={`${API}/api/videos/${video.id}/stream#t=4`}
                        muted
                        preload="metadata"
                      />
                      <span className="number">
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <span className="duration">
                        {timeLabel(video.duration)}
                      </span>
                      {video.latest_analysis_id && (
                        <span className="ready">已分析</span>
                      )}
                    </div>
                    <div className="case-copy">
                      <span>本地授权素材</span>
                      <h3>{caseName(video, index)}</h3>
                      <p>
                        {video.width || "—"} × {video.height || "—"} ·{" "}
                        {video.fps || "—"} FPS
                      </p>
                      <b>预览 →</b>
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <div className="offline">
                <div>
                  <strong>尚未选择训练视频</strong>
                  <p>点击“选择视频”，从电脑中直接选择需要分析的 MP4 文件。</p>
                </div>
                <VideoImportButton
                  busy={props.importing}
                  onImport={props.onImport}
                />
              </div>
            )}
          </section>

          <footer className="site-footer">
            <div>
              <strong>暨南大学“羽光智教”团队出品</strong>
              <span>本地视频分析与 2.5D 训练数据回放</span>
            </div>
            <span>训练建议仅供训练参考</span>
          </footer>
        </main>
      );
    };
  },
});

export default Landing;
