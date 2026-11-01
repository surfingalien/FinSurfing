import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { sharedCjs } from './tools/vite-shared-cjs.mjs'

const ROOT = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  // sharedCjs: lib/ files the browser shares with the server + Jest are CommonJS;
  // it converts the ones listed in its SHARED_CJS to ES modules in dev and in
  // the build alike (see tools/vite-shared-cjs.mjs).
  plugins: [react(), sharedCjs(ROOT)],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      }
    }
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom'],
          charts: ['recharts'],
        }
      }
    }
  }
})
