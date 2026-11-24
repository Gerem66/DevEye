import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FeatureError } from '@deveye/types/sdk/server';

import type { TestSession } from './accounts';
import { allRefused, targets, type Shared } from './isolation';

const s: Shared = {
    workspaceId: 7,
    ids: { noteId: 4, folderId: 2 },
    canary: 'canari-abc',
    itemCanary: 'element-abc',
    baseline: [],
    roleId: 0
};

/** Un intrus dont chaque commande répond ce que le test lui dicte. */
function intruder(answers: Record<string, () => unknown>): { session: TestSession; sent: unknown[] } {
    const sent: unknown[] = [];
    const client = {
        send: async (command: string, input: unknown, opts: unknown) => {
            sent.push([command, input, opts]);
            return answers[command]();
        }
    };
    return { session: { client } as unknown as TestSession, sent };
}

const refuse =
    (code: string, message = 'Refusé') =>
    () => {
        throw new FeatureError(code as never, message);
    };

describe('allRefused', () => {
    it('passe quand chaque sonde est refusée et que les lectures ne rendent rien de la victime', async () => {
        const { session, sent } = intruder({
            'notes.get': refuse('not_found'),
            'notes.delete': refuse('forbidden'),
            'notes.list': () => ({ notes: [] })
        });
        const detail = await allRefused(
            session,
            s,
            [
                ['notes.get', { noteId: 4 }],
                ['notes.delete', { noteId: 4 }]
            ],
            [['notes.list', {}]],
            {},
            7
        );
        assert.equal(detail, '2 sonde(s) et 1 lecture(s) sans rien de la victime');
        assert.deepEqual(sent[0], ['notes.get', { noteId: 4 }, { workspaceId: 7 }]);
    });

    it('envoie sans espace sur l’enveloppe quand l’intrus agit depuis le sien', async () => {
        const { session, sent } = intruder({ 'notes.get': refuse('not_found') });
        await allRefused(session, s, [['notes.get', { noteId: 4 }]], [], {});
        assert.deepEqual(sent[0], ['notes.get', { noteId: 4 }, {}]);
    });

    it('échoue sur une sonde qui réussit, sauf une commande indulgente', async () => {
        const answers = { 'notes.folderReorder': () => ({ folders: [] }) };
        const probe = [['notes.folderReorder', { folderIds: [2] }]] as const;
        await assert.rejects(
            allRefused(intruder(answers).session, s, probe, [], {}),
            /notes\.folderReorder .* : a réussi/
        );
        await allRefused(intruder(answers).session, s, probe, [], { 'notes.folderReorder': 'La liste peut dater.' });
    });

    it('échoue sur un refus qui ne prouve rien', async () => {
        const { session } = intruder({ 'notes.edit': refuse('validation') });
        await assert.rejects(
            allRefused(session, s, [['notes.edit', { noteId: 4 }]], [], {}),
            /refusée pour une autre raison \(validation\)/
        );
    });

    it('échoue sur une réponse qui porte une marque de la victime, refus et commande indulgente compris', async () => {
        const inRefusal = intruder({ 'notes.get': refuse('not_found', 'Note « canari-abc » introuvable') });
        await assert.rejects(
            allRefused(inRefusal.session, s, [['notes.get', { noteId: 4 }]], [], {}),
            /la réponse porte la marque de la victime/
        );
        const inLenient = intruder({ 'notes.folderReorder': () => ({ folders: [{ name: 'Dossier element-abc' }] }) });
        await assert.rejects(
            allRefused(inLenient.session, s, [['notes.folderReorder', { folderIds: [2] }]], [], {
                'notes.folderReorder': 'x'
            }),
            /la réponse porte la marque d’un élément de la victime/
        );
        const inRead = intruder({ 'notes.list': () => ({ notes: [{ title: 'Note canari-abc' }] }) });
        await assert.rejects(
            allRefused(inRead.session, s, [], [['notes.list', {}]], {}),
            /notes\.list .* la réponse porte la marque/
        );
    });

    it('laisse une lecture être refusée, pas pour une autre raison', async () => {
        await allRefused(
            intruder({ 'notes.get': refuse('forbidden') }).session,
            s,
            [],
            [['notes.get', { noteId: 4 }]],
            {}
        );
        await assert.rejects(
            allRefused(
                intruder({ 'notes.get': refuse('internal') }).session,
                s,
                [],
                [['notes.get', { noteId: 4 }]],
                {}
            ),
            /refusée pour une autre raison \(internal\)/
        );
    });
});

describe('targets', () => {
    it('reconnaît la sonde qui vise un élément fermé, par le nom et la valeur de son identifiant', () => {
        assert.equal(targets(['notes.get', { noteId: 4 }], ['noteId'], s.ids), true);
        assert.equal(targets(['notes.edit', { noteId: 4, note: {} }], ['noteId'], s.ids), true);
        assert.equal(targets(['notes.get', { noteId: 5 }], ['noteId'], s.ids), false);
        assert.equal(targets(['notes.folderDelete', { folderId: 2 }], ['noteId'], s.ids), false);
        assert.equal(targets(['notes.reorder', { folderId: 4, noteIds: [4] }], ['noteId'], s.ids), false);
        assert.equal(targets(['notes.list', {}], ['noteId'], s.ids), false);
    });
});
