import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { SdkFeatureContext } from '@deveye/types/sdk/server';
import { createTestContext, createTestServiceDeps } from '@deveye/types/sdk/testing';

import { dedupeKeyOf, sealHit } from './_shared';
import { moderationHandlers } from './handlers';
import type { HitRow, ModerationRepo, RuleRow } from './repo';
import { setRuntime } from './service';

/** Les commandes : un ajout ne compte que le neuf et refuse un motif de nom invalide, un modérateur ne voit pas d'où vient une détection. */

const { keys } = createTestServiceDeps();

function repoWith(rules: RuleRow[], hits: HitRow[] = []) {
    return {
        listRules: async () => rules,
        findRule: async (id: number) => rules.find((r) => r.id === id) ?? null,
        insertRules: async (rows: { kind: string; pattern: string; label: string }[]) => {
            let added = 0;
            for (const row of rows) {
                if (rules.some((r) => r.kind === row.kind && r.pattern === row.pattern)) continue;
                rules.push({ ...(row as RuleRow), id: rules.length + 1, hits: 0, last_hit: null, created: 1 });
                added += 1;
            }
            return added;
        },
        deleteRule: async (id: number) => {
            const before = rules.length;
            rules.splice(0, rules.length, ...rules.filter((r) => r.id !== id));
            return before - rules.length;
        },
        listHits: async () => hits
    } as unknown as ModerationRepo;
}

function contextFor(repo: ModerationRepo, isAdmin: boolean) {
    const ctx = createTestContext<ModerationRepo>({ repo, isAdmin });
    return { ...ctx, keys } as unknown as SdkFeatureContext<ModerationRepo>;
}

function handler(command: string) {
    const def = moderationHandlers.find((h) => h.command === command);
    assert.ok(def, `handler ${command} manquant`);
    return def.handler as (ctx: SdkFeatureContext<ModerationRepo>, input: unknown) => Promise<unknown>;
}

setRuntime({
    rulesChanged: () => undefined,
    feedStatus: async () => ({ configured: false, count: 0, lastImport: null, lastError: null }),
    importFeed: async () => undefined
});

describe('x-moderation.rulesAdd', () => {
    it('pose un motif par ligne, ignore les doublons, et donne au libellé vide celui du motif', async () => {
        const rules: RuleRow[] = [];
        const repo = repoWith(rules);
        const ctx = contextFor(repo, false);
        const out = (await handler('x-moderation.rulesAdd')(ctx, {
            rules: {
                kind: 'name',
                text: '*.torrent\n# commentaire\n*.TORRENT\nkeygen?.exe',
                reason: 'copyright',
                label: '',
                exposure: 'public'
            }
        })) as { added: number; ignored: number };
        assert.deepEqual(out, { added: 2, ignored: 1 });
        assert.equal(rules[0].label, 'Atteinte au droit d’auteur ou à une marque');
        const again = (await handler('x-moderation.rulesAdd')(ctx, {
            rules: { kind: 'name', text: '*.torrent', reason: 'copyright', label: 'Torrent', exposure: 'public' }
        })) as { added: number; ignored: number };
        assert.deepEqual(again, { added: 0, ignored: 1 });
    });

    it('refuse un motif de nom invalide en nommant sa ligne', async () => {
        const ctx = contextFor(repoWith([]), false);
        await assert.rejects(
            handler('x-moderation.rulesAdd')(ctx, {
                rules: {
                    kind: 'name',
                    text: '*.exe\ndossier/fichier',
                    reason: 'malware',
                    label: '',
                    exposure: 'public'
                }
            }),
            /Ligne 2/
        );
    });

    it('ne compte que les empreintes neuves', async () => {
        const known = 'a'.repeat(64);
        const repo = repoWith([
            {
                id: 1,
                kind: 'fingerprint',
                pattern: known,
                reason: 'malware',
                label: 'x',
                exposure: 'everywhere',
                source: 'manual',
                created_by: null,
                hits: 0,
                last_hit: null,
                created: 1
            }
        ]);
        const out = (await handler('x-moderation.rulesAdd')(contextFor(repo, false), {
            rules: {
                kind: 'fingerprint',
                text: `${known}\n${'b'.repeat(64)}\nrien`,
                reason: 'malware',
                label: 'Import',
                exposure: 'everywhere'
            }
        })) as { added: number; ignored: number };
        assert.deepEqual(out, { added: 1, ignored: 2 });
    });
});

describe('x-moderation.hits', () => {
    it('tait l’espace et le compte d’origine à un modérateur, pas à un administrateur', async () => {
        const dedupe = dedupeKeyOf({
            feature: 'cloudsync',
            workspaceId: 3,
            ruleId: 1,
            sha256: null,
            name: 'film.torrent'
        });
        const hit: HitRow = {
            id: 1,
            feature: 'cloudsync',
            rule_id: 1,
            kind: 'name',
            reason: 'copyright',
            label: 'Torrent',
            content: sealHit(keys, dedupe, { name: 'film.torrent', context: 'Documents' }),
            sha256: null,
            size: 12,
            workspace_id: 3,
            user_id: 9,
            dedupe_key: dedupe,
            count: 2,
            first_seen: 1,
            last_seen: 2
        };
        type Out = { hits: { name: string; context: string; workspaceId: number | null; userId: number | null }[] };
        const repo = repoWith([], [hit]);
        const moderator = (await handler('x-moderation.hits')(contextFor(repo, false), { limit: 10 })) as Out;
        assert.equal(moderator.hits[0].name, 'film.torrent');
        assert.equal(moderator.hits[0].context, 'Documents');
        assert.equal(moderator.hits[0].workspaceId, null);
        assert.equal(moderator.hits[0].userId, null);
        const admin = (await handler('x-moderation.hits')(contextFor(repo, true), { limit: 10 })) as Out;
        assert.equal(admin.hits[0].workspaceId, 3);
        assert.equal(admin.hits[0].userId, 9);
    });
});
