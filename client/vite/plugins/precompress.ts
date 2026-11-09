import { readdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { brotliCompress, constants as zlibConstants, gzip } from 'node:zlib';
import path from 'path';
import type { Plugin } from 'vite';

const COMPRESSIBLE = /\.(js|css|html|json|svg|ttf|txt)$/;

/**
 * Chaque fichier texte du build doublé d'un `.br` et d'un `.gz`, que le serveur
 * sert selon `Accept-Encoding` (`preCompressed`, app.ts) : le premier chargement
 * pèse le quart de son poids brut, sans compresser à chaque requête.
 */
export function precompress(): Plugin {
    const toBrotli = promisify(brotliCompress);
    const toGzip = promisify(gzip);
    let root = '';
    return {
        name: 'deveye:precompress',
        apply: 'build',
        configResolved(config) {
            root = path.resolve(config.root, config.build.outDir);
        },
        async closeBundle() {
            const files = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter(
                (rel) => COMPRESSIBLE.test(rel) && !rel.startsWith('.well-known')
            );
            await Promise.all(
                files.map(async (rel) => {
                    const full = path.join(root, rel);
                    const source = await readFile(full);
                    const variants: [string, Buffer][] = [
                        [
                            '.br',
                            await toBrotli(source, {
                                params: {
                                    [zlibConstants.BROTLI_PARAM_QUALITY]: zlibConstants.BROTLI_MAX_QUALITY,
                                    [zlibConstants.BROTLI_PARAM_SIZE_HINT]: source.length
                                }
                            })
                        ],
                        ['.gz', await toGzip(source, { level: zlibConstants.Z_BEST_COMPRESSION })]
                    ];
                    for (const [ext, data] of variants) {
                        if (data.length < source.length) await writeFile(full + ext, data);
                    }
                })
            );
        }
    };
}
