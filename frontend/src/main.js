// 创建并挂载前端应用。

import { createApp } from "vue";
import App from "./App.jsx";
import "./style.css";
import { client } from "./api.js";
createApp(App).mount("#root");
// 定期向后端报告页面仍在使用。
const heartbeat = () => client.get("/api/heartbeat").catch(() => {});
heartbeat();
setInterval(heartbeat, 30000);
