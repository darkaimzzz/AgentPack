import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: { entry: resolve('electron/main.ts') },
      rollupOptions: { output: { format: 'es' } },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: { entry: resolve('electron/preload.ts') },
      // .cjs, not .cjs-content-in-.mjs: package.json is type:module, so a bare
      // .js here would be parsed as ESM and the preload would fail to load.
      rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.cjs' } },
    },
  },
  renderer: {
    root: 'src',
    plugins: [react()],
    build: { rollupOptions: { input: resolve('src/index.html') } },
  },
})
