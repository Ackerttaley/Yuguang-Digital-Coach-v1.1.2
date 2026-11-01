// 对应界面：侧边导航。文字和交互在本文件，外观在同名 CSS 中。

import { jsx } from "../view.js";
import { defineComponent } from "vue";
import Shuttle from "./羽球图标.jsx";

const Sidebar = defineComponent({
  name: "Sidebar",
  props: {
    section: {},
    onSection: {},
    onExit: {},
  },
  inheritAttrs: false,
  setup(props) {
    // 页面状态与交互处理。

    // 页面显示内容。
    return () => {
      return (
        <aside className="hub-sidebar">
          <button
            className="hub-logo"
            onClick={props.onExit}
            aria-label="返回官网首页"
          >
            <span>
              <Shuttle />
            </span>
            <strong>羽光</strong>
          </button>
          <nav aria-label="平台功能导航">
            {[
              ["home", "⌂", "训练中心"],
              ["training", "▦", "训练分析"],
              ["analysis", "◉", "姿态分析"],
              ["twin", "◇", "2.5D 回放"],
              ["reports", "▤", "训练报告"],
              ["models", "◎", "模型选择"],
            ].map(([key, icon, label]) => (
              <button
                key={key}
                className={props.section === key ? "active" : ""}
                onClick={() => props.onSection(key)}
              >
                <i>{icon}</i>
                <span>{label}</span>
              </button>
            ))}
          </nav>
        </aside>
      );
    };
  },
});

export default Sidebar;
