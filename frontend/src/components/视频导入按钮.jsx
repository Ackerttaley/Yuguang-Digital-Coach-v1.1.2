// 对应界面：视频导入按钮。文字和交互在本文件，外观在同名 CSS 中。

import { jsx } from "../view.js";
import { defineComponent, shallowRef } from "vue";

const VideoImportButton = defineComponent({
  name: "VideoImportButton",
  props: {
    busy: {},
    disabled: {},
    onImport: {},
    variant: {
      default: "solid",
    },
  },
  inheritAttrs: false,
  setup(props) {
    // 页面状态与交互处理。
    const input = shallowRef(null);

    // 页面显示内容。
    return () => {
      return (
        <span className="video-import">
          <input
            ref={input}
            type="file"
            accept="video/mp4,.mp4"
            aria-label="选择本地 MP4 视频"
            disabled={props.busy || props.disabled}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file) void props.onImport(file);
            }}
          />
          <button
            className={props.variant === "solid" ? "solid-btn" : "outline-btn"}
            type="button"
            disabled={props.busy || props.disabled}
            onClick={() => input.value?.click()}
          >
            {props.busy ? "正在导入…" : "＋ 选择视频"}
          </button>
        </span>
      );
    };
  },
});

export default VideoImportButton;
