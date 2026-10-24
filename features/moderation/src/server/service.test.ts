import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MODERATION_PROVIDER, type ModerationProvider, type ModerationSubject } from '@deveye/types/sdk';
import { createTestServiceDeps } from '@deveye/types/sdk/testing';

import { openHit } from './_shared';
import type { ModerationRepo, RuleRow } from './repo';
import { createModerationService } from './service';

/**
 * Le provider : une empreinte interdite arrête un fichier partout, un motif de
 * nom public n'arrête rien dans le stockage privé, et la même détection relue
 * ne fait qu'une ligne.
 */

function rule(partial: Partial<RuleRow>): RuleRow {
    return {
        id: 1,
        kind: 'fingerprint',
        pattern: 'a'.repeat(64),
        reason: 'malware',
        label: 'Logiciel malveillant connu',
        exposure: 'everywhere',
        source: 'manual',
        created_by: null,
        hits: 0,
        last_hit: null,
        created: 1,
        ...partial
    };
}

function harness(rules: RuleRow[]) {
    const hits: { dedupe_key: string; content: string; count: number; user_id: number | null }[] = [];
    const bumped: number[] = [];
    const repo = {
        listNameRules: async () => rules.filter((r) => r.kind === 'name'),
        findFingerprint: async (sha256: string) =>
            rules.find((r) => r.kind === 'fingerprint' && r.pattern === sha256) ?? null,
        recordHit: async (row: { dedupe_key: string; content: string; user_id: number | null }) => {
            const existing = hits.find((h) => h.dedupe_key === row.dedupe_key);
            if (existing) existing.count += 1;
            else hits.push({ ...row, count: 1 });
        },
        bumpRule: async (id: number) => {
            bumped.push(id);
        },
        insertRules: async (rows: { pattern: string }[]) => {
            let added = 0;
            for (const row of rows) {
                if (rules.some((r) => r.kind === 'fingerprint' && r.pattern === row.pattern)) continue;
                rules.push(rule({ id: rules.length + 1, pattern: row.pattern, source: 'takedown' }));
                added += 1;
            }
            return added;
        },
        purgeHits: async () => 0,
        countBySource: async () => 0,
        getMeta: async () => null,
        setMeta: async () => undefined
    } as unknown as ModerationRepo;
    const deps = createTestServiceDeps<ModerationRepo>({ repo });
    const service = createModerationService(deps);
    const provider = service.providers?.[MODERATION_PROVIDER] as ModerationProvider;
    return { provider, hits, bumped, keys: deps.keys, rules };
}

const subject = (partial: Partial<ModerationSubject>): ModerationSubject => ({
    sha256: null,
    name: 'rapport.pdf',
    exposure: 'public',
    origin: { feature: 'x-hosting', workspaceId: 3, userId: 9, context: 'Plaquette 2026' },
    ...partial
});

describe('moderation.check', () => {
    it('arrête une empreinte interdite et journalise la détection, scellée', async () => {
        const { provider, hits, bumped, keys } = harness([rule({})]);
        const hit = await provider.check(subject({ sha256: 'A'.repeat(64), name: 'setup.exe', exposure: 'private' }));
        assert.deepEqual(hit, {
            ruleId: 1,
            kind: 'fingerprint',
            reason: 'malware',
            label: 'Logiciel malveillant connu'
        });
        assert.equal(hits.length, 1);
        assert.equal(bumped[0], 1);
        assert.deepEqual(openHit(keys, hits[0]), { name: 'setup.exe', context: 'Plaquette 2026' });
    });

    it('ne regarde pas le stockage privé avec une règle de nom publique', async () => {
        const { provider } = harness([rule({ id: 2, kind: 'name', pattern: '*.torrent', exposure: 'public' })]);
        assert.equal(await provider.check(subject({ name: 'film.torrent', exposure: 'private' })), null);
        const hit = await provider.check(subject({ name: 'Film.TORRENT', exposure: 'public' }));
        assert.equal(hit?.ruleId, 2);
    });

    it('relit la même détection sur une seule ligne', async () => {
        const { provider, hits } = harness([rule({})]);
        const same = subject({ sha256: 'a'.repeat(64), name: 'setup.exe' });
        await provider.check(same);
        await provider.check(same);
        await provider.check({ ...same, origin: { ...same.origin, workspaceId: 4 } });
        assert.equal(hits.length, 2);
        assert.equal(hits[0].count, 2);
    });

    it('ne trouve rien sans règle qui corresponde', async () => {
        const { provider, hits } = harness([rule({})]);
        assert.equal(await provider.check(subject({ sha256: 'b'.repeat(64) })), null);
        assert.equal(hits.length, 0);
    });
});

describe('moderation.ban', () => {
    it('interdit les empreintes neuves, sans compter celles déjà là ni ce qui n’en est pas une', async () => {
        const { provider, rules } = harness([rule({})]);
        const added = await provider.ban({
            fingerprints: ['A'.repeat(64), 'b'.repeat(64), 'pas une empreinte'],
            reason: 'copyright',
            label: 'Dossier retiré',
            by: 5
        });
        assert.equal(added, 1);
        assert.equal(rules.length, 2);
        assert.equal(rules[1].source, 'takedown');
    });
});
