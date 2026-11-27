import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// 渲染进程构建：目标 Chromium 108（Electron 22，Win7 最后支持的版本）
export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  plugins: [react()],
  // 直接给出编译选项，不让 esbuild 去找每个文件旁边的 tsconfig.json：共用的手机端代码旁边是 mobile/tsconfig.json，
  // 它继承 expo/tsconfig.base，CI 打包电脑端时没装手机端依赖，会找不到而失败
  // （要写成字符串：传对象时 Vite 仍会去读 tsconfig.json 再合并）
  esbuild: { tsconfigRaw: JSON.stringify({ compilerOptions: { jsx: 'react-jsx', useDefineForClassFields: true } }) },
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
        capture: resolve(__dirname, 'src/renderer/capture.html'),
      },
    },
  },
});
