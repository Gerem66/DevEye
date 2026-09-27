import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { accountExportProblem, type SdkExportWriter } from '@deveye/types/sdk/server';
import { createTestContext } from '@deveye/types/sdk/testing';

import { financeAccountExport } from './accountExport';
import { sealConnection, type StoredConnection } from './banking';
import { serverEntry } from './index';
import { fakeRepo } from './_testing';

describe('export du compte', () => {
    it('donne un sort valable à chaque table', () => {
        assert.ok(serverEntry.accountExport);
        assert.equal(accountExportProblem(serverEntry.accountExport), null);
    });

    it('écrit les connexions bancaires sans leurs accès à la banque', async () => {
        const repo = fakeRepo();
        const ctx = createTestContext({ repo });
        const stored: StoredConnection = {
            label: 'Pro',
            bankName: 'Qonto',
            secret: { login: 'org-login', secretKey: 'sk-qonto' },
            accounts: [{ id: 'acc-1', name: 'Courant', ibanEnd: '1234', currency: 'EUR' }]
        };
        await repo.createConnection(1, {
            provider: 'qonto',
            validUntil: null,
            content: await sealConnection(ctx, stored)
        });
        const written = new Map<string, unknown[]>();
        const out: SdkExportWriter = {
            json: () => Promise.resolve(),
            rows: async (path, source) => {
                const rows: unknown[] = [];
                for await (const row of source) rows.push(row);
                written.set(path, rows);
            },
            table: () => Promise.resolve(),
            file: () => Promise.resolve()
        };
        await financeAccountExport.workspace?.({
            repo,
            q: { query: () => Promise.resolve([]), execute: () => Promise.resolve({ affectedRows: 0, insertId: 0 }) },
            userId: 1,
            out,
            includes: () => true,
            keys: ctx.keys,
            signal: new AbortController().signal,
            logger: ctx.logger,
            workspace: { id: 1, kind: 'personal', name: 'Test' },
            cipher: ctx.cipher,
            open: (blob) => ctx.cipher().tryDecrypt(blob)
        });
        const rows = written.get('connexions-bancaires.json') as { provider: string; content: unknown }[];
        assert.equal(rows.length, 1);
        assert.equal(rows[0].provider, 'qonto');
        assert.deepEqual(rows[0].content, {
            label: 'Pro',
            bankName: 'Qonto',
            country: null,
            psuType: null,
            accounts: [{ id: 'acc-1', name: 'Courant', ibanEnd: '1234', currency: 'EUR' }]
        });
        assert.doesNotMatch(JSON.stringify(rows), /org-login|sk-qonto/);
    });
});
