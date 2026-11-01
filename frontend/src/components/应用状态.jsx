// 管理视频列表、当前会话、导入和页面切换。

import { Fragment, defineComponent, shallowRef, computed } from "vue";
import { jsx, observe } from "../view.js";
import {
  API,
  emptySession,
  MIN_ANALYSIS_SEGMENT_SECONDS,
  MAX_ANALYSIS_SEGMENT_SECONDS,
  timeLabel,
  apiJson,
  caseName,
} from "../shared.js";
import {
  readVideoMetadata,
  readStoredVideoMetadata,
} from "../browserVision.js";
import VideoSegmentSelector from "./视频片段弹窗.jsx";
import VideoRenameDialog from "./重命名弹窗.jsx";
import Landing from "./首页.jsx";
import PlatformHub from "./训练中心.jsx";
import AnalysisView from "./训练分析.jsx";

const Home = defineComponent({
  name: "Home",
  props: {},
  inheritAttrs: false,
  setup(props) {
    // 页面状态与交互处理。
    const videos = shallowRef([]);
    const screen = shallowRef("landing");
    const hubSection = shallowRef("home");
    const setHubSection = (value) => {
      hubSection.value =
        typeof value === "function" ? value(hubSection.value) : value;
    };
    const connection = shallowRef("loading");
    const session = shallowRef(emptySession);
    const analysisResult = shallowRef(null);
    const health = shallowRef(null);
    const importing = shallowRef(false);
    const importMessage = shallowRef(null);
    const importError = shallowRef(null);
    const segmentVideo = shallowRef(null);
    const renameTarget = shallowRef(null);
    const renaming = shallowRef(false);
    const deletingId = shallowRef(null);
    const renameError = shallowRef(null);

    const activeVideo = computed(
      () =>
        videos.value.find((video) => video.id === session.value.video_id) ??
        null,
    );
    const load = async () => {
      connection.value = "loading";
      try {
        const [storedVideos, healthResult] = await Promise.all([
          apiJson(`${API}/api/videos`),
          apiJson(`${API}/api/health`),
        ]);
        const videoList = await Promise.all(
          storedVideos.map(async (video) => {
            if (video.duration > 0) return video;
            const metadata = await readStoredVideoMetadata(video.id);
            return apiJson(
              `${API}/api/videos/${encodeURIComponent(video.id)}/metadata`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(metadata),
              },
            );
          }),
        );
        videos.value = videoList;
        health.value = healthResult;
        connection.value = "online";
        session.value = ((current) => {
          if (
            current.video_id &&
            videoList.some((video) => video.id === current.video_id)
          ) {
            return current;
          }
          const recent =
            videoList.find((video) => video.latest_analysis_id) ??
            videoList[0] ??
            null;
          if (!recent) return emptySession;
          return {
            ...emptySession,
            video_id: recent.id,
            analysis_id: recent.latest_analysis_id ?? null,
            status: recent.latest_analysis_id ? "loading" : "idle",
          };
        })(session.value);
      } catch {
        connection.value = "offline";
        health.value = null;
      }
    };
    observe(
      () => {
        const timer = window.setTimeout(() => void load(), 0);
        return () => window.clearTimeout(timer);
      },
      () => [load],
    );
    observe(
      () => {
        if (!session.value.video_id || !session.value.analysis_id) return;
        const controller = new AbortController();
        const requestedVideoId = session.value.video_id;
        const requestedAnalysisId = session.value.analysis_id;
        apiJson(`${API}/api/analyses/${requestedAnalysisId}`, {
          signal: controller.signal,
        })
          .then((result) => {
            if (
              result.video_id !== requestedVideoId ||
              result.analysis_id !== requestedAnalysisId
            ) {
              throw new Error("结果与当前会话不匹配");
            }
            analysisResult.value = result;
            session.value = ((current) =>
              current.video_id === requestedVideoId &&
              current.analysis_id === requestedAnalysisId
                ? {
                    ...current,
                    calibration_id: result.calibration_id,
                    player_side: result.player_side,
                    status: "ready",
                    source: current.source ?? result.source,
                    segment_start: result.segment?.start ?? 0,
                    segment_end: result.segment?.end ?? null,
                    error: null,
                  }
                : current)(session.value);
          })
          .catch((error) => {
            if (controller.signal.aborted) return;
            analysisResult.value = null;
            session.value = ((current) =>
              current.video_id === requestedVideoId &&
              current.analysis_id === requestedAnalysisId
                ? {
                    ...current,
                    status: "failed",
                    error:
                      error instanceof Error
                        ? error.message
                        : "读取分析结果失败",
                  }
                : current)(session.value);
          });
        return () => controller.abort();
      },
      () => [session.value.analysis_id, session.value.video_id],
    );
    observe(
      () => {
        const syncScreen = () => {
          screen.value =
            new URLSearchParams(window.location.search).get("view") ===
            "platform"
              ? "platform"
              : "landing";
        };
        syncScreen();
        window.addEventListener("popstate", syncScreen);
        return () => window.removeEventListener("popstate", syncScreen);
      },
      () => [],
    );
    observe(
      () => {
        window.scrollTo({
          top: 0,
          behavior: "instant",
        });
      },
      () => [screen.value, hubSection.value],
    );
    function openVideo(video) {
      segmentVideo.value = video;
    }
    async function importVideo(file) {
      if (!file.name.toLowerCase().endsWith(".mp4")) {
        importMessage.value = null;
        importError.value = "当前仅支持 MP4 视频，请重新选择。";
        return;
      }
      importing.value = true;
      importMessage.value = null;
      importError.value = null;
      try {
        const metadata = await readVideoMetadata(file);
        const imported = await apiJson(
          `${API}/api/videos/import?filename=${encodeURIComponent(file.name)}&duration=${metadata.duration}&width=${metadata.width}&height=${metadata.height}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/octet-stream",
            },
            body: file,
          },
        );
        videos.value = ((current) => [
          imported,
          ...current.filter((video) => video.id !== imported.id),
        ])(videos.value);
        analysisResult.value = null;
        session.value = {
          ...emptySession,
          video_id: imported.id,
        };
        segmentVideo.value = imported;
        importMessage.value = `已导入“${imported.name}”，请预览并选择分析区间。`;
      } catch (error) {
        importError.value =
          error instanceof Error ? error.message : "视频导入失败，请重试。";
      } finally {
        importing.value = false;
      }
    }
    // 仅删除平台导入的副本及其分析记录。
    async function deleteVideo(video) {
      if (
        !window.confirm(
          `删除“${caseName(video)}”及其分析记录？此操作无法撤销。`,
        )
      )
        return;
      deletingId.value = video.id;
      importError.value = null;
      importMessage.value = null;
      try {
        await apiJson(`${API}/api/videos/${encodeURIComponent(video.id)}`, {
          method: "DELETE",
        });
        videos.value = videos.value.filter((item) => item.id !== video.id);
        if (session.value.video_id === video.id) {
          session.value = { ...emptySession };
          analysisResult.value = null;
        }
        if (segmentVideo.value?.id === video.id) segmentVideo.value = null;
        if (renameTarget.value?.id === video.id) renameTarget.value = null;
        importMessage.value = "视频及分析记录已删除。";
      } catch (error) {
        importError.value = error.message || "删除失败，请重试。";
      } finally {
        deletingId.value = null;
      }
    }

    async function renameVideo(displayName) {
      if (!renameTarget.value) return;
      renaming.value = true;
      renameError.value = null;
      try {
        const renamed = await apiJson(
          `${API}/api/videos/${encodeURIComponent(renameTarget.value.id)}`,
          {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              display_name: displayName,
            }),
          },
        );
        videos.value = ((current) =>
          current.map((video) => (video.id === renamed.id ? renamed : video)))(
          videos.value,
        );
        segmentVideo.value = ((current) =>
          current?.id === renamed.id ? renamed : current)(segmentVideo.value);
        analysisResult.value = ((current) =>
          current?.video_id === renamed.id
            ? {
                ...current,
                video: {
                  ...current.video,
                  display_name: renamed.display_name,
                },
              }
            : current)(analysisResult.value);
        importError.value = null;
        importMessage.value = null;
        renameTarget.value = null;
      } catch (error) {
        renameError.value =
          error instanceof Error ? error.message : "视频重命名失败，请重试。";
      } finally {
        renaming.value = false;
      }
    }
    function confirmSegment(start, end) {
      if (!segmentVideo.value) return;
      const selectedDuration = end - start;
      if (
        selectedDuration < MIN_ANALYSIS_SEGMENT_SECONDS ||
        selectedDuration > MAX_ANALYSIS_SEGMENT_SECONDS
      ) {
        importMessage.value = null;
        importError.value = "分析片段必须在 5 秒到 30 分钟之间。";
        return;
      }
      const video = segmentVideo.value;
      analysisResult.value = null;
      session.value = {
        ...emptySession,
        video_id: video.id,
        player_side:
          session.value.video_id === video.id
            ? session.value.player_side
            : "near",
        calibration_id:
          session.value.video_id === video.id
            ? session.value.calibration_id
            : null,
        segment_start: start,
        segment_end: end,
      };
      segmentVideo.value = null;
      navigateHub("training");
      importMessage.value = `已选择 ${timeLabel(start, true)} – ${timeLabel(end, true)}，后续仅分析该区间。`;
    }
    function changeScreen(next) {
      screen.value = next;
      window.history.pushState(
        {
          view: next,
        },
        "",
        next === "platform" ? "/?view=platform" : "/",
      );
    }
    function navigateHub(section) {
      setHubSection(section);
      screen.value = "platform";
      window.history.replaceState(
        {
          view: "platform",
          section,
        },
        "",
        "/?view=platform",
      );
    }
    const updateSession = (patch) => {
      if (
        patch.analysis_id === null &&
        (patch.status === "queued" || patch.status === "running")
      ) {
        analysisResult.value = null;
      }
      session.value = ((current) => ({
        ...current,
        ...patch,
      }))(session.value);
    };
    function handleAnalysisReady(result, jobId, source, calibrationId) {
      analysisResult.value = result;
      session.value = ((current) => ({
        ...current,
        video_id: result.video_id,
        calibration_id: calibrationId,
        job_id: jobId,
        analysis_id: result.analysis_id,
        player_side: result.player_side,
        status: "ready",
        source,
        segment_start: result.segment.start,
        segment_end: result.segment.end,
        error: null,
      }))(session.value);
      videos.value = ((current) =>
        current.map((video) =>
          video.id === result.video_id
            ? {
                ...video,
                latest_analysis_id: result.analysis_id,
              }
            : video,
        ))(videos.value);
    }

    // 页面显示内容。
    return () => {
      let content;
      if (
        screen.value === "platform" &&
        hubSection.value === "training" &&
        activeVideo.value
      ) {
        content = (
          <AnalysisView
            key={activeVideo.value.id}
            video={activeVideo.value}
            session={session.value}
            result={
              analysisResult.value?.video_id === activeVideo.value.id
                ? analysisResult.value
                : null
            }
            onBack={() => navigateHub("home")}
            onNavigate={navigateHub}
            onSessionChange={updateSession}
            onAnalysisReady={handleAnalysisReady}
          />
        );
      } else if (screen.value === "platform") {
        content = (
          <PlatformHub
            videos={videos.value}
            connection={connection.value}
            importing={importing.value}
            importMessage={importMessage.value}
            importError={importError.value}
            section={hubSection.value}
            activeVideo={activeVideo.value}
            session={session.value}
            result={
              analysisResult.value?.video_id === session.value.video_id
                ? analysisResult.value
                : null
            }
            health={health.value}
            onSection={setHubSection}
            onExit={() => changeScreen("landing")}
            onImport={importVideo}
            onOpen={openVideo}
            onDelete={deleteVideo}
            deletingId={deletingId.value}
            onRename={(video) => {
              renameError.value = null;
              renameTarget.value = video;
            }}
          />
        );
      } else {
        content = (
          <Landing
            videos={videos.value}
            connection={connection.value}
            importing={importing.value}
            importMessage={importMessage.value}
            importError={importError.value}
            onRetry={() => void load()}
            onImport={importVideo}
            onOpen={openVideo}
            onEnter={() => changeScreen("platform")}
          />
        );
      }
      return (
        <>
          {content}
          {segmentVideo.value && (
            <VideoSegmentSelector
              key={segmentVideo.value.id}
              video={segmentVideo.value}
              initialStart={
                session.value.video_id === segmentVideo.value.id
                  ? session.value.segment_start
                  : 0
              }
              initialEnd={
                session.value.video_id === segmentVideo.value.id
                  ? session.value.segment_end
                  : null
              }
              onCancel={() => (segmentVideo.value = null)}
              onConfirm={confirmSegment}
            />
          )}
          {renameTarget.value && (
            <VideoRenameDialog
              key={renameTarget.value.id}
              video={renameTarget.value}
              busy={renaming.value}
              error={renameError.value}
              onCancel={() => {
                if (renaming.value) return;
                renameError.value = null;
                renameTarget.value = null;
              }}
              onRename={renameVideo}
            />
          )}
        </>
      );
    };
  },
});

export default Home;
