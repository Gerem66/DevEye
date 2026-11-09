import { createReadStream, existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'path';
import type { Plugin } from 'vite';
import { APP_DIR } from '../paths';

/** Le repli d'Excalidraw vers un CDN, que le paquet ajoute à chaque police après le chemin local. */
const EXCALIDRAW_CDN_FALLBACK = /"ASSETS_FALLBACK_URL",`https:\/\/esm\.sh\/[\s\S]*?\/dist\/prod\/`/;

const SELF = 'client/vite/plugins/excalidrawFonts.ts';

/**
 * Les polices d'Excalidraw (Tableau blanc), servies par DevEye : le paquet les
 * chercherait sinon sur un CDN. Le dossier porte la version du paquet, ce qui
 * rend sûr le cache immuable de `/assets/` alors que certains noms de fichiers
 * ne changent pas d'une version à l'autre. En dev, lues dans `node_modules` ;
 * au build, copiées telles quelles (déjà compressées), et le repli vers le CDN
 * remplacé par ce même dossier : sans lui, un SVG exporté pourrait encore
 * nommer le CDN. Le build échoue si le paquet change la forme de ce repli.
 */
export function excalidrawFonts(): Plugin & { assetPath: string | null } {
    const pkgDir = path.join(APP_DIR, 'node_modules', '@excalidraw', 'excalidraw');
    const pkgFile = path.join(pkgDir, 'package.json');
    if (!existsSync(pkgFile)) return { name: 'deveye:excalidraw-fonts', assetPath: null };
    const { version } = JSON.parse(readFileSync(pkgFile, 'utf-8')) as { version: string };
    const fontsDir = path.join(pkgDir, 'dist', 'prod', 'fonts');
    const base = `assets/excalidraw-${version}/`;
    let fallbackReplaced = false;
    let bundled = false;
    return {
        name: 'deveye:excalidraw-fonts',
        assetPath: `/${base}`,
        transform(code, id) {
            if (!id.includes('/@excalidraw/excalidraw/dist/prod/')) return null;
            bundled = true;
            if (!code.includes('"ASSETS_FALLBACK_URL"')) return null;
            if (!EXCALIDRAW_CDN_FALLBACK.test(code)) {
                this.error(`Excalidraw : la forme du repli vers le CDN a changé, à revoir dans ${SELF}`);
            }
            fallbackReplaced = true;
            return {
                code: code.replace(
                    EXCALIDRAW_CDN_FALLBACK,
                    `"ASSETS_FALLBACK_URL",new URL(${JSON.stringify(`/${base}`)},window.location.origin).href`
                ),
                map: null
            };
        },
        configureServer(server) {
            server.middlewares.use(`/${base}fonts/`, (req, res, next) => {
                const rel = decodeURIComponent((req.url ?? '').split('?')[0]).replace(/^\/+/, '');
                const file = path.resolve(fontsDir, rel);
                if (!file.startsWith(fontsDir + path.sep) || !existsSync(file)) return next();
                res.setHeader('Content-Type', 'font/woff2');
                createReadStream(file).pipe(res);
            });
        },
        generateBundle() {
            if (bundled && !fallbackReplaced) {
                this.error(`Excalidraw : le repli vers le CDN n’a pas été trouvé, à revoir dans ${SELF}`);
            }
            const files = readdirSync(fontsDir, { recursive: true, encoding: 'utf8' }).filter((rel) =>
                rel.endsWith('.woff2')
            );
            for (const rel of files) {
                this.emitFile({
                    type: 'asset',
                    fileName: `${base}fonts/${rel.split(path.sep).join('/')}`,
                    source: readFileSync(path.join(fontsDir, rel))
                });
            }
        }
    };
}
