// 前端构建配置与开发环境接口代理。

import { defineConfig } from "vite";
export default defineConfig({
  esbuild: { jsxFactory: "jsx", jsxFragment: "Fragment" },
  server: { host: "127.0.0.1", proxy: { "/api": "http://127.0.0.1:8012" } },
  build: { outDir: "dist", emptyOutDir: true },
});
