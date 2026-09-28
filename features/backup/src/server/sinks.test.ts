import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { memoryObjectStore } from '@deveye/types/sdk/testing';

import { HostedSink } from './sinks';

async function* once(data: string): AsyncGenerator<Buffer> {
    yield Buffer.from(data);
}

/**
 * La destination « sur le serveur » : une clé relative par archive, cloisonnée
 * par espace, et un refus net quand le serveur les perdrait au redéploiement.
 */
describe('HostedSink', () => {
    it('range l’archive sous l’espace et son dossier, et rend sa clé', async () => {
        const store = memoryObjectStore();
        const sink = new HostedSink(store, 4, 'nuit/base');
        const { artifact, size } = await sink.write('dump.sql.gz', once('contenu'));
        assert.equal(artifact, 'ws-4/nuit/base/dump.sql.gz');
        assert.equal(size, 7);
        assert.equal(store.objects.get(artifact)?.toString(), 'contenu');
    });

    it('n’efface qu’une archive de son dossier', async () => {
        const store = memoryObjectStore();
        await store.put('ws-5/autre.sql.gz', Buffer.from('à un autre espace'));
        const sink = new HostedSink(store, 4, '');
        await assert.rejects(sink.remove('ws-5/autre.sql.gz'), /hors du dossier/);
        await assert.rejects(sink.remove('ws-4/../ws-5/autre.sql.gz'), /hors du dossier/);
        assert.equal(store.objects.size, 1);
    });

    it('refuse d’écrire, et le contrôle échoue, sur une racine hors volume', async () => {
        const store = memoryObjectStore({ kind: 'local', ephemeralRoot: '/data/backup' });
        const sink = new HostedSink(store, 4, '');
        await assert.rejects(sink.write('dump.sql.gz', once('x')), /« \/data\/backup ».*BACKUP_STORAGE_DIR/s);
        assert.equal(store.objects.size, 0);
        const probe = await sink.probe();
        assert.equal(probe.ok, false);
        assert.match(probe.error ?? '', /aucun volume monté/);
    });
});
