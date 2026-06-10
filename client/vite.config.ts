import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [react()],
    server: {
        port: 3000,
        open: true,
        // Same-origin dev: proxy API + WebSocket to the Fastify server so the
        // browser only ever talks to localhost:3000 (no CORS, cookies just work).
        proxy: {
            '/api': { target: 'http://localhost:8081', changeOrigin: true },
            '/ws': { target: 'http://localhost:8081', ws: true, changeOrigin: true }
        }
    },
    build: {
        outDir: 'build',
        sourcemap: true
    },
    resolve: {
        alias: {
            '@': path.resolve(__dirname, 'src')
        }
    }
});
