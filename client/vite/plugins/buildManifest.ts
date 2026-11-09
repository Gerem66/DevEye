import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'path';
import type { Plugin } from 'vite';

/**
 * `.well-known/deveye-build.json` : chaque fichier du build et son SHA-256.
 * Ce n'est pas une référence de confiance (un serveur compromis le réécrirait
 * avec le reste) mais la LISTE de ce qu'un contrôle d'intégrité tenu par une
 * autre instance doit relire, morceaux chargés à la demande compris. Les cartes
 * de source n'y sont pas : le serveur ne les sert pas. Les `.br` et `.gz` non
 * plus : ils sortent sous le nom de leur original.
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
                    if (/\.(map|br|gz)$/.test(rel) || rel === manifestPath) continue;
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
