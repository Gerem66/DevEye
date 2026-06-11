import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

const serverPort = process.env.HTTP_PORT ?? '8081';
const serverOrigin = `http://localhost:${serverPort}`;

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [react()],
    server: {
        port: 5173,
        open: true,
        // Same-origin dev: proxy API + WebSocket to the Fastify server so the
        // browser only ever talks to localhost:5173 (no CORS, cookies just work).
        proxy: {
            '/api': { target: serverOrigin, changeOrigin: true },
            '/ws': { target: serverOrigin, ws: true, changeOrigin: true }
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
