import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { DatabaseRows, DatabaseStructure, DatabaseTable } from '../contracts/domain';
import { FeatureError } from '@deveye/types/sdk/server';

import type { PageRequest, Session } from './engine';
import { buildExport, DEFAULT_EXPORT_LIMITS, type ExportLimits } from './explore';

/**
 * L'export sur une session factice : trois formats sur des valeurs piégeuses,
 * un JSON valide sur une base entière, la pagination, les plafonds, les refus.
 */

interface FakeTable {
    schema: string;
    name: string;
    columns: string[];
    primaryKey: string[];
    rows: (string | null)[][];
}

/** Une session qui ne sait que lister, décrire et paginer ; le reste lève. */
function fakeSession(tables: FakeTable[]): Session & { pages: PageRequest[] } {
    const pages: PageRequest[] = [];
    const unused = async () => {
        throw new Error('non attendu ici');
    };
    const find = (schema: string, name: string): FakeTable => {
        const t = tables.find((x) => x.name === name && x.schema === schema);
        if (!t) throw new Error(`table inconnue ${schema}.${name}`);
        return t;
    };
    return {
        pages,
        serverVersion: unused,
        inventory: unused,
        tables: async (): Promise<DatabaseTable[]> =>
            tables.map((t) => ({ schema: t.schema, name: t.name, rowCount: t.rows.length, sizeBytes: null })),
        structure: async (schema, table): Promise<DatabaseStructure> => {
            const t = find(schema, table);
            return {
                schema,
                table,
                columns: t.columns.map((name) => ({
                    name,
                    type: 'text',
                    nullable: true,
                    default: null,
                    primaryKey: t.primaryKey.includes(name),
                    generated: false,
                    comment: ''
                })),
                primaryKey: t.primaryKey,
                foreignKeys: [],
                indexes: []
            };
        },
        tableRows: async (schema, table, page): Promise<DatabaseRows> => {
            pages.push(page);
            const t = find(schema, table);
            return {
                columns: t.columns,
                rows: t.rows.slice(page.offset, page.offset + page.limit),
                total: t.rows.length,
                elapsedMs: 0
            };
        },
        query: unused,
        execute: unused,
        insertRow: unused,
        updateRow: unused,
        deleteRows: unused,
        close: async () => undefined
    };
}

/** Des valeurs qui cassent un export naïf : guillemet, apostrophe, virgule, NULL, accents. */
const TRICKY: FakeTable = {
    schema: 'shop',
    name: 'clients',
    columns: ['id', 'name', 'note'],
    primaryKey: ['id'],
    rows: [
        ['1', 'Dupont "Le Grand"', "l'été, à Nîmes"],
        ['2', 'Émilie', null]
    ]
};

const EMPTY: FakeTable = { schema: 'shop', name: 'vide', columns: ['id'], primaryKey: ['id'], rows: [] };

function twelveRows(): FakeTable {
    return {
        schema: 'shop',
        name: 'lignes',
        columns: ['id', 'v'],
        primaryKey: ['id'],
        rows: Array.from({ length: 12 }, (_, i) => [String(i + 1), `v${i + 1}`])
    };
}

describe('buildExport : les trois formats', () => {
    it('CSV : champs toujours cités, guillemets doublés, NULL vide', async () => {
        const out = await buildExport(fakeSession([TRICKY]), { format: 'csv', schema: 'shop', table: 'clients' });
        assert.equal(
            out.content,
            '"id","name","note"\n' + '"1","Dupont ""Le Grand""","l\'été, à Nîmes"\n' + '"2","Émilie",\n'
        );
        assert.deepEqual([out.rowCount, out.tableCount, out.truncated], [2, 1, false]);
    });

    it('SQL : littéraux cités, apostrophes doublées, NULL nu', async () => {
        const out = await buildExport(fakeSession([TRICKY]), { format: 'sql', table: 'clients' });
        assert.ok(out.content.includes('-- shop.clients'));
        assert.ok(
            out.content.includes(
                "INSERT INTO `clients` (`id`, `name`, `note`) VALUES ('1', 'Dupont \"Le Grand\"', 'l''été, à Nîmes');"
            )
        );
        assert.ok(out.content.includes("VALUES ('2', 'Émilie', NULL);"));
    });

    it('JSON : un document valide sur une base entière, table vide comprise', async () => {
        const out = await buildExport(fakeSession([TRICKY, EMPTY]), { format: 'json' });
        const parsed = JSON.parse(out.content) as { table: string; rows: Record<string, string | null>[] }[];
        assert.deepEqual(
            parsed.map((t) => [t.table, t.rows.length]),
            [
                ['clients', 2],
                ['vide', 0]
            ]
        );
        assert.deepEqual(parsed[0].rows[1], { id: '2', name: 'Émilie', note: null });
        assert.equal(out.tableCount, 2);
        assert.equal(out.rowCount, 2);
    });

    it('CSV sur une base entière : un en-tête nommé sépare les tables', async () => {
        const out = await buildExport(fakeSession([TRICKY, EMPTY]), { format: 'csv' });
        assert.ok(out.content.includes('\n# shop.clients\n'));
        assert.ok(out.content.includes('\n# shop.vide\n'));
    });
});

describe('buildExport : pagination et plafonds', () => {
    const byThree: ExportLimits = { ...DEFAULT_EXPORT_LIMITS, page: 3 };

    it('lit par pages de trois sans perte ni doublon', async () => {
        const session = fakeSession([twelveRows()]);
        const out = await buildExport(session, { format: 'json', table: 'lignes' }, byThree);
        const parsed = JSON.parse(out.content) as { rows: { id: string }[] }[];
        const ids = parsed[0].rows.map((r) => Number(r.id));
        assert.deepEqual(ids, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
        assert.equal(out.rowCount, 12);
        // Quatre pages exactement : la dernière borne est le total annoncé.
        assert.deepEqual(
            session.pages.map((p) => p.offset),
            [0, 3, 6, 9]
        );
    });

    it('le plafond de lignes tronque, et le dit', async () => {
        const out = await buildExport(
            fakeSession([twelveRows()]),
            { format: 'csv', table: 'lignes' },
            {
                ...byThree,
                maxRows: 5
            }
        );
        assert.equal(out.rowCount, 5);
        assert.equal(out.truncated, true);
    });

    it("le plafond d'octets tronque aussi, compté en octets réels", async () => {
        const out = await buildExport(
            fakeSession([TRICKY]),
            { format: 'csv', table: 'clients' },
            {
                ...DEFAULT_EXPORT_LIMITS,
                // L'en-tête et la première ligne dépassent : la seconde ne part pas.
                maxBytes: Buffer.byteLength('"id","name","note"\n') + 10
            }
        );
        assert.equal(out.rowCount, 1);
        assert.equal(out.truncated, true);
    });
});

describe('buildExport : ce qui n’atteint jamais le moteur', () => {
    it('une table inconnue répond `not_found` sans lire une ligne', async () => {
        const session = fakeSession([TRICKY]);
        await assert.rejects(
            buildExport(session, { format: 'csv', table: 'Clients' }),
            (e: unknown) => e instanceof FeatureError && e.code === 'not_found'
        );
        assert.deepEqual(session.pages, []);
    });

    it('des plages sur une clé composite répondent `conflict`', async () => {
        const composite: FakeTable = { ...TRICKY, name: 'paires', primaryKey: ['id', 'name'] };
        await assert.rejects(
            buildExport(fakeSession([composite]), {
                format: 'csv',
                table: 'paires',
                idRanges: [{ from: 1, to: 5 }]
            }),
            (e: unknown) => e instanceof FeatureError && e.code === 'conflict'
        );
    });

    it('des plages sur une clé simple bornent la lecture par la colonne du catalogue', async () => {
        const session = fakeSession([TRICKY]);
        await buildExport(session, { format: 'csv', table: 'clients', idRanges: [{ from: 1, to: 1 }] });
        assert.deepEqual(session.pages[0].ranges, { column: 'id', ranges: [{ from: 1, to: 1 }] });
    });

    it('des plages sur une base entière sont ignorées', async () => {
        const session = fakeSession([TRICKY, EMPTY]);
        await buildExport(session, { format: 'csv', idRanges: [{ from: 1, to: 1 }] });
        assert.equal(session.pages[0].ranges, undefined);
    });
});
