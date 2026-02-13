import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({
      include: ['process', 'buffer', 'stream', 'events', 'util', 'path', 'crypto', 'http', 'https', 'url', 'zlib', 'timers', 'vm', 'tty', 'os', 'constants'],
      globals: {
        Buffer: true,
        global: true,
        process: true,
      },
    }),
  ],
  resolve: {
    alias: {
      // webtorrent: 'webtorrent/dist/webtorrent.min.js', // removed to use source/main
    },
  },
  server: {
    port: 5173,
    host: true,
    allowedHosts: true,
    proxy: {
      '/socket.io': {
        target: 'http://localhost:3001',
        ws: true,
      },
    },
  },
  optimizeDeps: {
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
  },
  build: {
    target: 'esnext',
    outDir: 'dist',
  },
  base: './',
});
