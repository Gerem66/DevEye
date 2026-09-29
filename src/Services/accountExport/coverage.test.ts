import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { FeatureAccountExport, SdkExportTable, SdkQueryable } from '@deveye/types/sdk/server';

import { assertExportCoverage, CORE_EXPORT_TABLES, exportCoverage } from './coverage';

function schema(tables: Record<string, string[]>): SdkQueryable {
    const rows = Object.entries(tables).flatMap(([t, columns]) => columns.map((c) => ({ t, c })));
    return {
        query: async <T extends object>() => rows as unknown as T[],
        execute: async () => ({ affectedRows: 0, insertId: 0 })
    };
}

const CORE = Object.fromEntries(Object.keys(CORE_EXPORT_TABLES).map((t) => [t, ['id']]));

const notes = (entry: Partial<SdkExportTable> = {}): FeatureAccountExport => ({
    tables: {
        ft_notes: {
            file: 'notes.json',
            where: 'workspace_id = ?',
            key: ['id'],
            sealed: ['content_enc'],
            ...entry
        }
    }
});

describe('exportCoverage', () => {
    it('accepte un schéma dont chaque table a un sort', async () => {
        const report = await exportCoverage(schema({ ...CORE, ft_notes: ['id', 'workspace_id', 'content_enc'] }), [
            { id: 'notes', entry: notes() }
        ]);
        assert.deepEqual(report, { faults: [], uncovered: [] });
    });

    it('rend les tables sans sort, celles d’un module qui ne déclare rien comprises', async () => {
        const report = await exportCoverage(schema({ ...CORE, ft_notes: ['id'], ft_old_thing: ['id'] }), [
            { id: 'notes', entry: undefined }
        ]);
        assert.deepEqual(report.faults, []);
        assert.deepEqual(report.uncovered, ['ft_notes', 'ft_old_thing']);
    });

    it('tait les tables du socle d’un module absent, et les exige de lui une fois installé', async () => {
        const q = schema({ ...CORE, sync_files: ['id'] });
        assert.deepEqual((await exportCoverage(q, [])).uncovered, []);
        assert.deepEqual((await exportCoverage(q, [{ id: 'cloudsync', entry: undefined }])).uncovered, ['sync_files']);
    });

    it('refuse une colonne chiffrée ni ouverte ni tue', async () => {
        const report = await exportCoverage(
            schema({ ...CORE, ft_notes: ['id', 'workspace_id', 'content_enc', 'title_enc'] }),
            [{ id: 'notes', entry: notes() }]
        );
        assert.equal(report.faults.length, 1);
        assert.match(report.faults[0], /ft_notes\.title_enc/);
    });

    it('refuse une colonne à allure de secret, sauf tue ou gardée', async () => {
        const q = schema({ ...CORE, ft_notes: ['id', 'workspace_id', 'content_enc', 'api_token', 'dedup_hash'] });
        const loose = await exportCoverage(q, [{ id: 'notes', entry: notes() }]);
        assert.deepEqual(
            loose.faults.map((f) => /« (\S+) »/.exec(f)?.[1]),
            ['ft_notes.api_token', 'ft_notes.dedup_hash']
        );
        const tight = await exportCoverage(q, [
            { id: 'notes', entry: notes({ omit: ['api_token'], keep: ['dedup_hash'] }) }
        ]);
        assert.deepEqual(tight.faults, []);
    });

    it('refuse une table ou une colonne qui n’existe pas', async () => {
        const report = await exportCoverage(schema({ ...CORE, ft_notes: ['id', 'workspace_id', 'content_enc'] }), [
            { id: 'notes', entry: notes({ key: ['uid'] }) },
            { id: 'ghost', entry: { tables: { ft_ghost: { skip: 'Rien.' } } } }
        ]);
        assert.deepEqual(report.faults, [
            'notes : colonne « ft_notes.uid » inconnue',
            'ghost : table « ft_ghost » absente du schéma'
        ]);
    });

    it('refuse une table déclarée deux fois', async () => {
        const report = await exportCoverage(schema({ ...CORE, users: ['id'] }), [
            { id: 'notes', entry: { tables: { users: { skip: 'Déjà là.' } } } }
        ]);
        assert.deepEqual(report.faults, ['notes : table « users » déjà déclarée par cœur']);
    });

    it('au boot, une faute arrête et une table sans sort se dit seulement', async () => {
        const q = schema({ ...CORE, ft_notes: ['id', 'workspace_id', 'content_enc', 'body_enc'] });
        await assert.rejects(assertExportCoverage(q, [{ id: 'notes', entry: notes() }]), /body_enc/);
        assert.deepEqual(await assertExportCoverage(schema({ ...CORE, ft_left: ['id'] }), []), ['ft_left']);
    });
});
