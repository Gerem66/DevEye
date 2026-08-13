import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';
import { existsSync, readFileSync } from 'node:fs';

const serverPort = process.env.LISTEN_PORT ?? '3000';
const serverOrigin = `http://localhost:${serverPort}`;

// Single source of truth for the app version: the root package.json. The client
// has no `version` of its own — `__APP_VERSION__` is injected at build time.
const { version: appVersion } = JSON.parse(readFileSync(path.resolve(__dirname, '../package.json'), 'utf-8'));

/**
 * Where the client reads the shared contracts from.
 *
 * `deveye-types` is a published package, but between releases it's edited in
 * place inside `node_modules` — and Vite serves anything under `node_modules`
 * with a one-year `immutable` cache, under a `?v=` URL that only changes when
 * package.json or the lockfile do. A contract change therefore stayed invisible
 * to an already-loaded browser however many times the dev server restarted,
 * surfacing as "Unknown command" with nothing pointing at the cause.
 *
 * In dev, resolving to the sibling checkout instead makes it ordinary source:
 * watched, hot-reloaded, never over-cached. Builds always take the installed
 * package, so the release path is untouched — and the checkout is optional, the
 * alias simply doesn't apply when it isn't there.
 */
const TYPES_SOURCE_ENTRY = path.resolve(__dirname, '../../DevEye-Types/src/index.ts');

// https://vitejs.dev/config/
export default defineConfig(({ command }) => {
    const useTypesSource = command === 'serve' && existsSync(TYPES_SOURCE_ENTRY);

    return {
        define: {
            __APP_VERSION__: JSON.stringify(appVersion)
        },
        plugins: [react()],
        optimizeDeps: {
            // `deveye-types` ships TypeScript source and is the one dependency that
            // changes in step with the app. Vite's dep pre-bundling keys its cache on
            // package.json/lockfile hashes, never on a dependency's file contents, so
            // editing the package in place (which is how it's iterated on before a
            // release) left the browser served a stale bundle — missing exports that
            // exist on disk, with no hint as to why. Excluding it from pre-bundling
            // routes it through the normal transform pipeline, where edits are picked
            // up like any other source file.
            exclude: ['deveye-types']
        },
        server: {
            port: 5173,
            open: true,
            // Same-origin dev: proxy API + WebSocket to the Fastify server so the
            // browser only ever talks to localhost:5173 (no CORS, cookies just work).
            proxy: {
                '/api': { target: serverOrigin, changeOrigin: true },
                '/ws': { target: serverOrigin, ws: true, changeOrigin: true },
                // Le script de mesure d'audience vit **hors de `/api`** : c'est
                // l'adresse qu'on colle dans une page, et `/t.js` se retient.
                // Sans cette entrée, Vite le cherche parmi ses propres fichiers
                // et rend un 404 — la balise semble alors cassée alors que le
                // serveur la sert parfaitement sur le port 3000.
                '/t.js': { target: serverOrigin, changeOrigin: true }
            }
        },
        build: {
            outDir: 'build',
            sourcemap: true,
            chunkSizeWarningLimit: 1024,
            rollupOptions: {
                output: {
                    // Split heavy third-party libs into their own long-lived chunks so the
                    // app bundle stays small and vendor code is cached across deploys.
                    manualChunks(id) {
                        if (!id.includes('node_modules')) return undefined;
                        if (id.includes('framer-motion')) return 'framer-motion';
                        // xterm is only pulled in by the lazily-loaded terminal panel; keep
                        // it in its own chunk so it loads on demand, not on first paint.
                        if (id.includes('@xterm')) return 'xterm';
                        if (id.includes('/react') || id.includes('/scheduler')) return 'react-vendor';
                        return 'vendor';
                    }
                }
            }
        },
        resolve: {
            alias: {
                '@': path.resolve(__dirname, 'src'),
                ...(useTypesSource ? { 'deveye-types': TYPES_SOURCE_ENTRY } : {})
            }
        }
    };
});
