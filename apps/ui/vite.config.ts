import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './',
  // Packaged builds must not ship the full source; opt in locally with AIK_SOURCEMAPS=1.
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: process.env.AIK_SOURCEMAPS === '1' },
  server: { port: 5173, strictPort: true },
});
