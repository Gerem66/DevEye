import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { z, ZodType } from 'zod';

import {
    osintHistory,
    osintHistoryClear,
    osintHistoryRemove,
    osintKeyList,
    osintLookup,
    osintProbe,
    osintSetKey
} from '../contracts/commands';
import type { OsintLookupRow, OsintProviderKeyRow } from '../contracts/domain';
import type { SdkFeatureContext } from '@deveye/types/sdk/server';
import { createTestContext } from '@deveye/types/sdk/testing';

import { osintHandlers } from './handlers';
import type { OsintRepo } from './repo';

/**
 * Ce qui se vérifie ici ne lève nulle part ailleurs : la cible d'une sonde est
 * re-déduite de la requête, et une sonde ne s'applique qu'aux natures qu'elle
 * déclare. Un contournement ne lèverait pas, il sonderait ce qu'il ne devrait pas.
 */

/** Le handler d'un contrat, typé par ce contrat (le registre est hétérogène). */
function handlerFor<C extends { command: string; input: ZodType; output: ZodType }>(contract: C) {
    const def = osintHandlers.find((h) => h.command === contract.command);
    assert.ok(def, `handler ${contract.command} manquant`);
    return def.handler as (
        ctx: SdkFeatureContext<OsintRepo>,
        input: z.output<C['input']>
    ) => Promise<z.input<C['output']>>;
}

interface FakeRepo extends OsintRepo {
    lookups: OsintLookupRow[];
    keys: OsintProviderKeyRow[];
}

/** Un dépôt en mémoire, même contrat que le vrai. Les tableaux sont mutés en
 *  place, jamais réassignés : les tests lisent `repo.lookups` après coup. */
function fakeRepo(): FakeRepo {
    let seq = 0;
    return {
        lookups: [],
        keys: [],
        async listLookups(workspaceId, limit) {
            return this.lookups.filter((l) => l.workspace_id === workspaceId).slice(0, limit);
        },
        async createLookup({ userId, workspaceId, kind, queryEnc }) {
            const row: OsintLookupRow = {
                id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
                workspace_id: workspaceId,
                user_id: userId,
                kind,
                query_enc: queryEnc,
                created: Date.now()
            };
            this.lookups.unshift(row);
            return row;
        },
        async deleteLookup(id, workspaceId) {
            const i = this.lookups.findIndex((l) => l.id === id && l.workspace_id === workspaceId);
            if (i === -1) return false;
            this.lookups.splice(i, 1);
            return true;
        },
        async clearLookups(workspaceId) {
            const kept = this.lookups.filter((l) => l.workspace_id !== workspaceId);
            const removed = this.lookups.length - kept.length;
            this.lookups.splice(0, this.lookups.length, ...kept);
            return removed;
        },
        async listKeys(workspaceId) {
            return this.keys.filter((k) => k.workspace_id === workspaceId);
        },
        async getKey(workspaceId, provider) {
            return this.keys.find((k) => k.workspace_id === workspaceId && k.provider === provider) ?? null;
        },
        async setKey(workspaceId, provider, keyEnc) {
            const row = this.keys.find((k) => k.workspace_id === workspaceId && k.provider === provider);
            if (row) row.key_enc = keyEnc;
            else this.keys.push({ workspace_id: workspaceId, provider, key_enc: keyEnc });
        },
        async deleteKey(workspaceId, provider) {
            const i = this.keys.findIndex((k) => k.workspace_id === workspaceId && k.provider === provider);
            if (i !== -1) this.keys.splice(i, 1);
        }
    };
}

describe('osint.lookup', () => {
    it('journalise la recherche chiffrée et rend les sondes de la nature reconnue', async () => {
        const repo = fakeRepo();
        const ctx = createTestContext({ repo });
        const out = await handlerFor(osintLookup)(ctx, { query: 'github.com' });

        assert.equal(out.target.kind, 'domain');
        assert.ok(out.probes.length > 0);
        assert.equal(repo.lookups.length, 1);
        // Le harnais chiffre à l'identité : la requête doit être passée par le
        // cipher (donc retrouvée telle quelle ici), jamais laissée en clair par
        // un autre chemin.
        assert.equal(repo.lookups[0].query_enc, 'github.com');
        // L'audit trace la nature, jamais la requête elle-même.
        assert.equal(ctx.recorded.audits.length, 1);
        assert.ok(!ctx.recorded.audits[0].description.includes('github.com'));
    });
});

describe('osint.probe — les gardes', () => {
    it('refuse une cible incohérente avec sa requête', async () => {
        const ctx = createTestContext({ repo: fakeRepo() });
        await assert.rejects(
            handlerFor(osintProbe)(ctx, {
                probe: 'dns',
                // Un client qui annonce « nom de personne » pour une requête qui
                // est en réalité un domaine : la nature re-déduite le trahit.
                target: { kind: 'person', value: 'github.com', query: 'github.com' }
            }),
            /incohérente/i
        );
    });

    it("refuse une sonde qui ne s'applique pas à la nature de la cible", async () => {
        const ctx = createTestContext({ repo: fakeRepo() });
        await assert.rejects(
            handlerFor(osintProbe)(ctx, {
                probe: 'phone',
                target: { kind: 'domain', value: 'github.com', query: 'github.com' }
            }),
            /ne s'applique pas/i
        );
    });
});

describe('osint.setKey / osint.keyList', () => {
    it('pose, compte puis efface une clé sans jamais la rendre', async () => {
        const repo = fakeRepo();
        const ctx = createTestContext({ repo });

        const posed = await handlerFor(osintSetKey)(ctx, { provider: 'pappers', key: 'secret-key' });
        assert.deepEqual(posed, { provider: 'pappers', hasKey: true });

        const listed = await handlerFor(osintKeyList)(ctx, {});
        const pappers = listed.providers.find((p) => p.provider === 'pappers');
        assert.equal(pappers?.hasKey, true);
        assert.ok(!JSON.stringify(listed).includes('secret-key'));

        // Clé vide = effacement, même commande.
        const cleared = await handlerFor(osintSetKey)(ctx, { provider: 'pappers', key: '  ' });
        assert.deepEqual(cleared, { provider: 'pappers', hasKey: false });
        assert.equal(repo.keys.length, 0);
    });
});

describe("l'historique", () => {
    it("liste, supprime une entrée, puis efface tout — borné à l'espace", async () => {
        const repo = fakeRepo();
        const ctx = createTestContext({ repo, workspaceId: 7 });
        await handlerFor(osintLookup)(ctx, { query: 'github.com' });
        await handlerFor(osintLookup)(ctx, { query: '8.8.8.8' });

        const listed = await handlerFor(osintHistory)(ctx, { limit: 30 });
        assert.equal(listed.entries.length, 2);

        const removed = await handlerFor(osintHistoryRemove)(ctx, { id: listed.entries[0].id });
        assert.equal(removed.id, listed.entries[0].id);

        const swept = await handlerFor(osintHistoryClear)(ctx, {});
        assert.equal(swept.removed, 1);
        assert.equal(repo.lookups.length, 0);
    });
});
