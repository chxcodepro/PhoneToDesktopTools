import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// 渲染进程构建：目标 Chromium 108（Electron 22，Win7 最后支持的版本）
export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  plugins: [react()],
  resolve: {
    // @agent：和手机端共用的 Agent 代码（Agent 循环、模型接口、联网工具），不依赖 React Native
    alias: { '@agent': resolve(__dirname, '../../mobile/src/agent'), '@': resolve(__dirname, 'src/renderer') },
  },
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    target: 'chrome108',
    cssTarget: 'chrome108',
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'src/renderer/index.html'),
        overlay: resolve(__dirname, 'src/renderer/overlay.html'),
      },
    },
  },
});
