import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solid()],
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: 'esnext',
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalized = id.replaceAll('\\', '/');
          if (!normalized.includes('/node_modules/')) return undefined;
          if (normalized.includes('/monaco-editor/')) return 'vendor-monaco';
          if (normalized.includes('/gifenc/')) return 'vendor-gif';
          if (normalized.includes('/mp4-muxer/')) return 'vendor-mp4';
          if (normalized.includes('/solid-js/')) return 'vendor-solid';
          if (normalized.includes('/@tauri-apps/')) return 'vendor-tauri';
          return undefined;
        },
      },
    },
  },
});
