// 对应界面：重命名弹窗。文字和交互在本文件，外观在同名 CSS 中。

import { jsx, observe } from "../view.js";
import { defineComponent, shallowRef, computed } from "vue";
import { caseName } from "../shared.js";

const VideoRenameDialog = defineComponent({
  name: "VideoRenameDialog",
  props: {
    video: {},
    busy: {},
    error: {},
    onCancel: {},
    onRename: {},
  },
  inheritAttrs: false,
  setup(props) {
    // 页面状态与交互处理。
    const displayName = shallowRef(caseName(props.video));

    const trimmedName = computed(() => displayName.value.trim());
    observe(
      () => {
        const handleEscape = (event) => {
          if (event.key === "Escape" && !props.busy) props.onCancel();
        };
        window.addEventListener("keydown", handleEscape);
        return () => window.removeEventListener("keydown", handleEscape);
      },
      () => [props.busy, props.onCancel],
    );

    // 页面显示内容。
    return () => {
      return (
        <div className="rename-modal" role="dialog" aria-modal="true">
          <form
            className="rename-dialog"
            onSubmit={(event) => {
              event.preventDefault();
              if (trimmedName.value && !props.busy)
                void props.onRename(trimmedName.value);
            }}
          >
            <header>
              <div>
                <span className="section-label">VIDEO NAME</span>
                <h2>重命名训练视频</h2>
                <p>名称会保存在本机，不会改变原视频文件和已有分析结果。</p>
              </div>
              <button
                className="segment-close"
                type="button"
                disabled={props.busy}
                onClick={props.onCancel}
                aria-label="关闭重命名窗口"
              >
                ×
              </button>
            </header>
            <label>
              <span>视频名称</span>
              <input
                autoFocus
                type="text"
                maxLength={80}
                value={displayName.value}
                onChange={(event) => (displayName.value = event.target.value)}
                aria-invalid={Boolean(props.error)}
                aria-describedby={props.error ? "rename-error" : undefined}
              />
            </label>
            {props.error && (
              <p className="rename-error" id="rename-error">
                {props.error}
              </p>
            )}
            <footer>
              <button
                className="outline-btn"
                type="button"
                disabled={props.busy}
                onClick={props.onCancel}
              >
                取消
              </button>
              <button
                className="solid-btn"
                type="submit"
                disabled={!trimmedName.value || props.busy}
              >
                {props.busy ? "正在保存…" : "保存名称"}
              </button>
            </footer>
          </form>
        </div>
      );
    };
  },
});

export default VideoRenameDialog;
