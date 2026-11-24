import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createTestEngine } from '../testing/harness';
import { HeadersTooLargeError, MAX_HEADER_BYTES } from './mailstore';

/** La colonne `meta` : un `MEDIUMTEXT`. */
const COLUMN_BYTES = 16_777_215;

/** Un message dont le bloc d'en-têtes pèse `size` octets, tout en `filler`. */
function withHeaders(size: number, filler: string): Buffer {
    const start = 'Subject: essai\r\nX-Long: ';
    const end = '\r\n\r\n';
    return Buffer.from(`${start}${filler.repeat(size - start.length - end.length)}${end}corps\r\n`, 'latin1');
}

async function inbox() {
    const engine = createTestEngine();
    const mailbox = await engine.createMailbox('alice@exemple.test', 'secret-d-alice');
    const folder = await engine.repo.findFolder(mailbox.id, 'INBOX');
    assert.ok(folder);
    return { engine, mailbox, folder };
}

describe('les en-têtes d’un message à garder', () => {
    it('sont admis jusqu’au plafond, et ce qui en est scellé tient dans sa colonne', async () => {
        const { engine, mailbox, folder } = await inbox();
        const row = await engine.store.append(mailbox, folder, withHeaders(MAX_HEADER_BYTES, 'x'), {
            internalDate: 1_788_000_000
        });
        const sealed = await engine.repo.messageMeta(row.id);
        assert.ok(sealed !== null && sealed.length < COLUMN_BYTES);
        assert.equal((await engine.store.readMeta(mailbox, row)).head.length, MAX_HEADER_BYTES);
    });

    it('sont refusés un octet au-delà, sans rien écrire', async () => {
        const { engine, mailbox, folder } = await inbox();
        await assert.rejects(
            engine.store.append(mailbox, folder, withHeaders(MAX_HEADER_BYTES + 1, 'x'), { internalDate: 1 }),
            HeadersTooLargeError
        );
        assert.equal(engine.repo.blobs.length, 0);
        assert.equal((await engine.repo.findById(mailbox.id))?.used_bytes, 0);
    });

    it('sont refusés sous le plafond quand des octets de contrôle en gonflent la copie au-delà de la colonne', async () => {
        const { engine, mailbox, folder } = await inbox();
        await assert.rejects(
            engine.store.append(mailbox, folder, withHeaders(MAX_HEADER_BYTES, '\u0001'), { internalDate: 1 }),
            HeadersTooLargeError
        );
        assert.equal(engine.repo.blobs.length, 0);
    });

    it('sont refusés quand ce sont ceux d’un message enfermé qui débordent', async () => {
        const { engine, mailbox, folder } = await inbox();
        const enclosed = `Content-Type: message/rfc822\r\n\r\nX-Long: ${'\u0001'.repeat(3 * MAX_HEADER_BYTES)}\r\n\r\ncorps`;
        await assert.rejects(
            engine.store.append(mailbox, folder, Buffer.from(enclosed, 'latin1'), { internalDate: 1 }),
            HeadersTooLargeError
        );
    });
});
