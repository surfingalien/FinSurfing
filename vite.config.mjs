import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { sharedCjsDev, sharedCjsPatterns } from './tools/vite/shared-cjs.mjs'

export default defineConfig({
  // sharedCjsDev: lib/ CommonJS modules the client imports, converted for the
  // dev server. The build converts the same list via commonjsOptions below.
  plugins: [sharedCjsDev(), react()],
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
    // The lib/ files the client imports are CommonJS (module.exports), shared
    // with the server + Jest. Rollup converts CommonJS only for files matching
    // `include`; a file left off the list still builds, but its import namespace
    // is empty, so its functions are undefined at runtime. The list is SHARED_CJS
    // in tools/vite/shared-cjs.mjs, which the dev plugin above also reads.
    commonjsOptions: {
      include: [...sharedCjsPatterns(), /node_modules/],
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
