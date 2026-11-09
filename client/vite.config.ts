import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import path from 'path';
import { defineConfig } from 'vite';
import { manualChunks } from './vite/chunks';
import { featureChunkRoots, installedFeaturePackages, siblingFeatureAliases } from './vite/features';
import { APP_DIR, CLIENT_DIR, WORKSPACE_DIR } from './vite/paths';
import { buildManifest } from './vite/plugins/buildManifest';
import { excalidrawFonts } from './vite/plugins/excalidrawFonts';
import { inlineIcons } from './vite/plugins/inlineIcons';
import { pdfjsAssets } from './vite/plugins/pdfjsAssets';
import { precompress } from './vite/plugins/precompress';
import { typesSourceAliases } from './vite/typesSource';

const serverOrigin = `http://localhost:${process.env.LISTEN_PORT ?? '3000'}`;

// La version vient du package.json de l'app : le client n'en a pas à lui.
const { version: appVersion } = JSON.parse(readFileSync(path.join(APP_DIR, 'package.json'), 'utf-8')) as {
    version: string;
};

export default defineConfig(({ command }) => {
    const fonts = excalidrawFonts();
    const pdfjs = pdfjsAssets();

    return {
        define: {
            __APP_VERSION__: JSON.stringify(appVersion),
            ...(fonts.assetPath ? { __EXCALIDRAW_ASSET_PATH__: JSON.stringify(fonts.assetPath) } : {}),
            ...(pdfjs.assetPath ? { __PDFJS_ASSET_PATH__: JSON.stringify(pdfjs.assetPath) } : {})
        },
        plugins: [react(), inlineIcons(), fonts, pdfjs, buildManifest(appVersion), precompress()],
        optimizeDeps: {
            // `@deveye/types` et les modules installés s'éditent en place, alors que
            // le cache du pré-bundling ne suit que package.json et le lockfile :
            // exclus, ils passent par la transformation ordinaire et chaque
            // modification se voit.
            exclude: ['@deveye/types', ...installedFeaturePackages()],
            // Le scan ne traverse pas les modules exclus : sans cette ligne, Excalidraw
            // est découvert à l'ouverture d'un tableau, et Vite recharge toute la page.
            // Même chose pour les bibliothèques de l'atelier PDF.
            include: [
                ...(fonts.assetPath ? ['@excalidraw/excalidraw'] : []),
                ...(pdfjs.assetPath ? ['pdfjs-dist', '@cantoo/pdf-lib', '@cantoo/fontkit', 'fflate'] : [])
            ]
        },
        server: {
            port: 5173,
            fs: {
                // La glue locale des modules privés importe des checkouts
                // frères (../DevEye-CloudSync/...) : le dev-serve doit pouvoir
                // les lire. Sans dossier frère, la permission est inerte.
                allow: [WORKSPACE_DIR]
            },
            open: true,
            // Le navigateur ne parle qu'au port de Vite : l'API et le WebSocket
            // sont relayés vers Fastify, sans CORS, cookies compris.
            proxy: {
                '/api': { target: serverOrigin, changeOrigin: true },
                '/ws': { target: serverOrigin, ws: true, changeOrigin: true },
                // Le script de mesure d'audience vit hors de `/api` : c'est
                // l'adresse qu'on colle dans une page. Sans cette entrée, Vite
                // le cherche parmi ses propres fichiers et rend un 404.
                '/t.js': { target: serverOrigin, changeOrigin: true },
                // L'icône des mails et des pages publiques, servie par le serveur.
                '/deveye-icon.png': { target: serverOrigin, changeOrigin: true }
            }
        },
        build: {
            outDir: 'build',
            // Les cartes de source restent produites pour lire une trace, mais
            // sans le commentaire `sourceMappingURL` : le navigateur ne les
            // demande pas, et le serveur ne les sert pas (app.ts).
            sourcemap: 'hidden',
            chunkSizeWarningLimit: 1024,
            rollupOptions: {
                output: { manualChunks: manualChunks(featureChunkRoots()) }
            }
        },
        resolve: {
            // Un module privé installé par chemin a son propre `node_modules`
            // (devDeps de son typecheck autonome) : sans dédoublonnage, ses
            // fichiers résolvaient `react` et `zod` vers SES copies, bundlées
            // en double, et deux React dans la même page cassent les hooks.
            dedupe: ['react', 'react-dom', 'zod', '@deveye/types'],
            alias: {
                '@': path.join(CLIENT_DIR, 'src'),
                // La surface client du SDK des modules : un vrai module de l'app,
                // servi sous son nom de contrat (voir src/sdk/index.ts).
                'deveye-sdk-client': path.join(CLIENT_DIR, 'src', 'sdk', 'index.ts'),
                ...(command === 'serve' ? { ...typesSourceAliases(), ...siblingFeatureAliases() } : {})
            }
        }
    };
});
