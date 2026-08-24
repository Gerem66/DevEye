import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';

import { BLOB_CHUNK_BYTES } from './devb';
import { openSealedStream, sealStream } from './crypto';

/**
 * Le scellement des archives est le seul endroit du système où une erreur ne se
 * voit **jamais** au moment où on la commet : une archive mal scellée s'écrit
 * sans broncher, se liste normalement, et n'échoue que le jour de la
 * restauration — c'est-à-dire le pire jour possible.
 *
 * Ces cas figent les quatre propriétés dont dépend une restauration : l'aller-
 * retour est fidèle quelle que soit la taille, le découpage d'entrée n'a aucune
 * influence sur la sortie, une troncature est détectée, et une altération l'est
 * aussi.
 */

const KEY = crypto.createHash('sha256').update('clé de test').digest();

async function* once(data: Buffer): AsyncGenerator<Buffer> {
    yield data;
}

async function collect(source: AsyncIterable<Buffer>): Promise<Buffer> {
    const parts: Buffer[] = [];
    for await (const chunk of source) parts.push(chunk);
    return Buffer.concat(parts);
}

async function roundTrip(data: Buffer, source?: AsyncIterable<Buffer>): Promise<Buffer> {
    const sealed = await collect(sealStream(KEY, source ?? once(data)));
    return collect(openSealedStream(KEY, once(sealed)));
}

describe('scellement des archives de sauvegarde', () => {
    it('rend exactement ce qu’on lui a donné, archive vide comprise', async () => {
        // L'archive vide n'est pas un cas d'école : un partage CloudSync sans
        // fichier produit un `tar` de deux blocs nuls, gzippé, et il doit se
        // relire comme les autres.
        for (const size of [0, 1, 1024, BLOB_CHUNK_BYTES - 1, BLOB_CHUNK_BYTES, BLOB_CHUNK_BYTES + 1]) {
            const data = crypto.randomBytes(size);
            assert.deepEqual(await roundTrip(data), data, `taille ${size}`);
        }
    });

    it('traverse plusieurs blocs sans perdre un octet', async () => {
        const data = crypto.randomBytes(BLOB_CHUNK_BYTES * 2 + 4321);
        assert.deepEqual(await roundTrip(data), data);
    });

    it('ignore le découpage de la source', async () => {
        // LE cas qui compte : `mysqldump` rend des morceaux de taille
        // arbitraire, jamais alignés sur un bloc. Si le scellement suivait ce
        // découpage, deux exécutions du même vidage produiraient des archives
        // de structures différentes — et l'ouvreur, qui compte les blocs, n'en
        // relirait aucune.
        const data = crypto.randomBytes(BLOB_CHUNK_BYTES + 9999);
        async function* ragged(): AsyncGenerator<Buffer> {
            let offset = 0;
            for (const size of [1, 7, 100_000, 3, BLOB_CHUNK_BYTES, 512]) {
                if (offset >= data.length) break;
                yield data.subarray(offset, Math.min(offset + size, data.length));
                offset += size;
            }
            if (offset < data.length) yield data.subarray(offset);
        }
        assert.deepEqual(await roundTrip(data, ragged()), data);
    });

    it('refuse une archive tronquée', async () => {
        const data = crypto.randomBytes(BLOB_CHUNK_BYTES * 2);
        const sealed = await collect(sealStream(KEY, once(data)));
        await assert.rejects(() => collect(openSealedStream(KEY, once(sealed.subarray(0, sealed.length - 64)))));
    });

    it('refuse une archive altérée', async () => {
        const sealed = await collect(sealStream(KEY, once(crypto.randomBytes(4096))));
        const tampered = Buffer.from(sealed);
        tampered[tampered.length - 40] ^= 0xff;
        await assert.rejects(() => collect(openSealedStream(KEY, once(tampered))));
    });

    it('refuse une archive scellée sous une autre clé', async () => {
        const sealed = await collect(sealStream(KEY, once(crypto.randomBytes(4096))));
        const other = crypto.createHash('sha256').update('autre clé').digest();
        await assert.rejects(() => collect(openSealedStream(other, once(sealed))));
    });
});
