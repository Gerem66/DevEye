import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'path';
import type { Plugin } from 'vite';

/**
 * Ce qui s'exécute ou met en forme une page, le SVG compris, qui peut porter un
 * script. Les polices, images et tables de pdf.js n'y tournent pas, et leurs
 * centaines de fichiers dépasseraient ce que relit le contrôle d'Uptime.
 */
const ACTIVE_FILE = /\.(html|m?js|css|wasm|svg)$/;

/**
 * `.well-known/deveye-build.json` : chaque fichier actif du build et son
 * SHA-256. Ce n'est pas une référence de confiance (un serveur compromis le
 * réécrirait avec le reste) mais la LISTE de ce qu'un contrôle d'intégrité tenu
 * par une autre instance doit relire, morceaux chargés à la demande compris.
 */
export function buildManifest(version: string): Plugin {
    let root = '';
    return {
        name: 'deveye:build-manifest',
        apply: 'build',
        configResolved(config) {
            // Le smoke construit ailleurs (`--outDir`) : jamais `build/` en dur.
            root = path.resolve(config.root, config.build.outDir);
        },
        closeBundle() {
            const manifestPath = path.join('.well-known', 'deveye-build.json');
            const files: Record<string, string> = {};
            const walk = (dir: string): void => {
                for (const entry of readdirSync(dir, { withFileTypes: true })) {
                    const full = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        walk(full);
                        continue;
                    }
                    const rel = path.relative(root, full).split(path.sep).join('/');
                    if (!ACTIVE_FILE.test(rel)) continue;
                    files[rel] = createHash('sha256').update(readFileSync(full)).digest('hex');
                }
            };
            walk(root);
            const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
            mkdirSync(path.join(root, '.well-known'), { recursive: true });
            writeFileSync(
                path.join(root, manifestPath),
                JSON.stringify({ format: 1, version, files: sorted }, null, 2) + '\n'
            );
        }
    };
}
