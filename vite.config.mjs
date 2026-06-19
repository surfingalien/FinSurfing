import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
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
    // lib/portfolio-pnl.js is a CommonJS module (module.exports) shared with the
    // server + Jest. Client code imports it via `import * as portfolioPnl`, but
    // Rollup only converts CommonJS to ES for node_modules by default — so the
    // source file must be added here, otherwise the bundle's namespace is empty
    // and portfolioPnl.* is undefined at runtime (build still "succeeds").
    commonjsOptions: {
      include: [/lib[\\/]portfolio-pnl/, /node_modules/],
    },
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
