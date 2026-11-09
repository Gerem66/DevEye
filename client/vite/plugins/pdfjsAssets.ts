import { createReadStream, existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'path';
import type { Plugin } from 'vite';
import { APP_DIR } from '../paths';

/**
 * Les fichiers que pdf.js va chercher à la demande (polices standard, tables
 * CMap, décodeurs d'images en JavaScript), servis par DevEye sous un chemin
 * versionné : le paquet ne connaît aucun CDN, et sans eux un PDF dont les
 * polices ne sont pas embarquées s'afficherait en carrés. Inactif tant que le
 * paquet n'est pas installé (un poste sans le module PDF).
 */
export function pdfjsAssets(): Plugin & { assetPath: string | null } {
    const pkgDir = path.join(APP_DIR, 'node_modules', 'pdfjs-dist');
    const pkgFile = path.join(pkgDir, 'package.json');
    if (!existsSync(pkgFile)) return { name: 'deveye:pdfjs-assets', assetPath: null };
    const { version } = JSON.parse(readFileSync(pkgFile, 'utf-8')) as { version: string };
    const base = `assets/pdfjs-${version}/`;
    const dirs = ['cmaps', 'standard_fonts', 'wasm'];
    const types: Record<string, string> = {
        '.js': 'text/javascript',
        '.wasm': 'application/wasm',
        '.ttf': 'font/ttf',
        '.pfb': 'application/octet-stream',
        '.bcmap': 'application/octet-stream'
    };
    return {
        name: 'deveye:pdfjs-assets',
        assetPath: `/${base}`,
        configureServer(server) {
            server.middlewares.use(`/${base}`, (req, res, next) => {
                const rel = decodeURIComponent((req.url ?? '').split('?')[0]).replace(/^\/+/, '');
                if (!dirs.includes(rel.split('/')[0])) return next();
                const file = path.resolve(pkgDir, rel);
                if (!file.startsWith(pkgDir + path.sep) || !existsSync(file)) return next();
                res.setHeader('Content-Type', types[path.extname(file)] ?? 'application/octet-stream');
                createReadStream(file).pipe(res);
            });
        },
        generateBundle() {
            for (const dir of dirs) {
                const root = path.join(pkgDir, dir);
                for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
                    if (!entry.isFile()) continue;
                    const file = path.join(entry.parentPath, entry.name);
                    const rel = path.relative(root, file).split(path.sep).join('/');
                    this.emitFile({ type: 'asset', fileName: `${base}${dir}/${rel}`, source: readFileSync(file) });
                }
            }
        }
    };
}
