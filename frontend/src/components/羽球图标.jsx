// 对应界面：羽球图标。文字和交互在本文件，外观在同名 CSS 中。

import { jsx } from "../view.js";
import { defineComponent } from "vue";

const Shuttle = defineComponent({
  name: "Shuttle",
  props: {},
  inheritAttrs: false,
  setup(props) {
    // 页面状态与交互处理。

    // 页面显示内容。
    return () => {
      return (
        <span className="shuttle">
          <i />
          <b />
        </span>
      );
    };
  },
});

export default Shuttle;
