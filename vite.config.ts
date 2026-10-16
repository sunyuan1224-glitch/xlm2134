import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Electron 用 loadFile 从 file:// 加载构建产物，资源必须是相对路径
  // （Tauri 走自定义协议根，所以以前用默认的 "/" 也能跑）
  base: "./",
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: "esnext",
    minify: "esbuild",
    sourcemap: false,
  },
});
