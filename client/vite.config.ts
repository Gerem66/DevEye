import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

const serverPort = process.env.LISTEN_PORT ?? '3000';
const serverOrigin = `http://localhost:${serverPort}`;

// Single source of truth for the app version: the root package.json. The client
// has no `version` of its own — `__APP_VERSION__` is injected at build time.
const { version: appVersion } = JSON.parse(readFileSync(path.resolve(__dirname, '../package.json'), 'utf-8'));

// https://vitejs.dev/config/
export default defineConfig({
    define: {
        __APP_VERSION__: JSON.stringify(appVersion)
    },
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
        sourcemap: true,
        rollupOptions: {
            output: {
                // Split heavy third-party libs into their own long-lived chunks so the
                // app bundle stays small and vendor code is cached across deploys.
                manualChunks(id) {
                    if (!id.includes('node_modules')) return undefined;
                    if (id.includes('framer-motion')) return 'framer-motion';
                    if (id.includes('/react') || id.includes('/scheduler')) return 'react-vendor';
                    return 'vendor';
                }
            }
        }
    },
    resolve: {
        alias: {
            '@': path.resolve(__dirname, 'src')
        }
    }
});
