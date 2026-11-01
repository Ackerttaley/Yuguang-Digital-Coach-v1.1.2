# Windows 运行说明

双击 start.cmd，访问 http://127.0.0.1:8012 。本文件夹已包含运行所需 Python 环境、依赖和构建页面，无需另装 Python 或 Node.js。若端口被占用，请先关闭占用服务。

stop.cmd 会停止服务并永久清空本目录内 videos 和 data，包括视频、分析结果及缓存。

前端源码仍在 frontend/src；重新构建前端需要另行安装 Node.js 和 npm 依赖。浏览器需支持 WebAssembly、Web Worker、OffscreenCanvas 和视频解码。
