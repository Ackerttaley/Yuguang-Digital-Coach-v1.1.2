// 对应界面：空状态提示。文字和交互在本文件，外观在同名 CSS 中。

import { jsx } from "../view.js";
import { defineComponent } from "vue";

const EmptyState = defineComponent({
  name: "EmptyState",
  props: {
    title: {},
    detail: {},
    action: {},
  },
  inheritAttrs: false,
  setup(props) {
    // 页面状态与交互处理。

    // 页面显示内容。
    return () => {
      return (
        <div className="hub-empty">
          <strong>{props.title}</strong>
          {props.detail && <p>{props.detail}</p>}
          {props.action}
        </div>
      );
    };
  },
});

export default EmptyState;
