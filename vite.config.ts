import { resolve } from 'node:path';
import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';

/** Each game lives in its own folder; the root page links to them. */
export default defineConfig({
  base: './',
  plugins: [preact()],
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        fogtag: resolve(import.meta.dirname, 'fogtag/index.html'),
      },
    },
  },
});
