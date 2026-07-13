import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Multi-page marketing site + demo. Dev server serves all three HTML files at
// their paths automatically; this config just tells the production build to
// emit all three entry points.
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        demo: resolve(__dirname, 'demo.html'),
        pricing: resolve(__dirname, 'pricing.html'),
      },
    },
  },
});
