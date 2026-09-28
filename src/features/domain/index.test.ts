import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Logger } from 'pino';
import { ACCOUNT_PLAN_PROVIDER, type AccountPlan, type FeatureManifest } from '@deveye/types/sdk';
import { FeatureError, type FeatureDomainsEntry, type SdkDomain } from '@deveye/types/sdk/server';

import type { FeatureDomainRow, FeatureDomainsRepo } from '@/db/repos/featureDomains';
import type { FeatureContext } from '@/features/_define';
import { createModuleServices, registerModules } from '@/features/_sdk/register';
import type { ModuleServiceHost } from '@/features/_sdk/service';
import { domainFeatures } from './index';

/**
 * Les quatre commandes, sur un dépôt en mémoire et un module enregistré une
 * fois en tête de fichier (le registre est un état de processus).
 */

type TestFeature = 'x-domyes' | 'x-domno' | 'x-domweb' | 'x-domsite' | 'x-domplan';

function manifest(id: TestFeature, domains: boolean, web = false): FeatureManifest {
    return {
        id,
        label: 'Test',
        description: 'Module de test des domaines.',
        icon: 'test',
        category: 'daily',
        notifies: false,
        hasItems: false,
        shareTier: 'never',
        resources: [],
        commands: [],
        ...(domains ? { domains: { hint: 'Vos noms.', service: 'Pointez le nom ici.', web } } : {})
    };
}

const webHooks: FeatureDomainsEntry = {
    records: () => Promise.resolve([]),
    probe: () => Promise.resolve({ ok: true })
};

/** L'offre que rend le fournisseur, réglée par chaque test. `null` : aucune limite. */
let plan: AccountPlan | null = null;

const removed: SdkDomain[] = [];
let refuseRemoval = false;

registerModules([
    {
        manifest: manifest('x-domyes', true),
        server: {
            features: [],
            domains: {
                records: (_ctx, domain) =>
                    Promise.resolve([{ type: 'CNAME', name: domain.host, value: 'deveye.test' }]),
                probe: () => Promise.resolve({ ok: true }),
                useCount: () => Promise.resolve(new Map([[1, 3]])),
                onRemoved: (_ctx, domain) => {
                    if (refuseRemoval) return Promise.reject(new Error('encore désigné'));
                    removed.push(domain);
                    return Promise.resolve();
                }
            }
        }
    },
    { manifest: manifest('x-domno', false), server: { features: [] } },
    { manifest: manifest('x-domweb', true, true), server: { features: [], domains: webHooks } },
    { manifest: manifest('x-domsite', true, true), server: { features: [], domains: webHooks } },
    {
        manifest: manifest('x-domplan', false),
        server: {
            features: [],
            createService: () => ({
                start() {},
                stop() {},
                providers: {
                    [ACCOUNT_PLAN_PROVIDER]: {
                        planFor: () =>
                            Promise.resolve(plan ?? { id: 'admin', label: 'Admin', limits: {}, priority: true })
                    }
                }
            })
        }
    }
]);

const quietLogger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
createModuleServices({
    db: { queryable: {} },
    crypt: {},
    audit: { record() {} },
    logger: quietLogger
} as unknown as ModuleServiceHost);

function memoryRepo(): FeatureDomainsRepo & { rows: FeatureDomainRow[] } {
    const rows: FeatureDomainRow[] = [];
    return {
        rows,
        list: (ws, feature) => Promise.resolve(rows.filter((r) => r.workspace_id === ws && r.feature === feature)),
        find: (id, ws, feature) =>
            Promise.resolve(rows.find((r) => r.id === id && r.workspace_id === ws && r.feature === feature) ?? null),
        findByHost: (feature, host) =>
            Promise.resolve(rows.find((r) => r.feature === feature && r.host === host) ?? null),
        insert: ({ workspaceId, feature, host, token, now }) => {
            const id = rows.length + 1;
            rows.push({
                id,
                workspace_id: workspaceId,
                feature,
                host,
                token,
                dns_state: 'pending',
                dns_error: '',
                probe_state: 'pending',
                probe_error: '',
                verified_at: null,
                checked_at: null,
                failures: 0,
                next_probe_at: now,
                created: now
            });
            return Promise.resolve(id);
        },
        saveState: () => Promise.resolve(),
        delete: (id) => {
            const at = rows.findIndex((r) => r.id === id);
            if (at !== -1) rows.splice(at, 1);
            return Promise.resolve(at !== -1);
        },
        due: () => Promise.resolve([]),
        hostsOf: (ids, features) =>
            Promise.resolve([
                ...new Set(
                    rows.filter((r) => ids.includes(r.workspace_id) && features.includes(r.feature)).map((r) => r.host)
                )
            ]),
        rowsOf: (ids, features) =>
            Promise.resolve(
                rows
                    .filter((r) => ids.includes(r.workspace_id) && features.includes(r.feature))
                    .map((r) => ({ id: r.id, workspace_id: r.workspace_id, host: r.host }))
            ),
        routable: () => Promise.resolve([])
    };
}

function context(repo: FeatureDomainsRepo, opts: { workspaceId?: number; level?: 'none' | 'read' | 'write' } = {}) {
    const level = opts.level ?? 'write';
    const audits: string[] = [];
    const ctx = {
        workspaceId: opts.workspaceId ?? 1,
        // Le compte 1 possède les espaces 1 et 2 : ses domaines s'y comptent ensemble.
        workspace: { ownerUserId: 1 },
        db: { featureDomains: repo, featureKv: {}, workspaces: { listOwnedIds: () => Promise.resolve([1, 2]) } },
        crypt: {},
        logger: { warn() {}, error() {}, info() {}, debug() {} },
        assertFeature: (_feature: string, wanted: 'read' | 'write' = 'read') => {
            const ok = level === 'write' || (level === 'read' && wanted === 'read');
            if (!ok) throw new FeatureError('forbidden', 'Accès refusé');
        },
        audit: (entry: { action: string }) => audits.push(entry.action)
    } as unknown as FeatureContext;
    return { ctx, audits };
}

function run(command: string, ctx: FeatureContext, input: unknown): Promise<unknown> {
    const def = domainFeatures.find((d) => d.command === command);
    assert.ok(def, command);
    return def.handler(ctx, def.input.parse(input)) as Promise<unknown>;
}

const code = (expected: string) => (error: unknown) => error instanceof FeatureError && error.code === expected;

describe('domain.* : l’autorisation', () => {
    it('lire demande la lecture, tout le reste l’écriture', async () => {
        const repo = memoryRepo();
        await assert.rejects(
            run('domain.list', context(repo, { level: 'none' }).ctx, { feature: 'x-domyes' }),
            code('forbidden')
        );
        const reader = context(repo, { level: 'read' }).ctx;
        await assert.doesNotReject(run('domain.list', reader, { feature: 'x-domyes' }));
        await assert.rejects(
            run('domain.add', reader, { feature: 'x-domyes', host: 'a.exemple.fr' }),
            code('forbidden')
        );
    });

    it('refuse une fonctionnalité qui ne gère pas de domaines', async () => {
        await assert.rejects(run('domain.list', context(memoryRepo()).ctx, { feature: 'x-domno' }), code('validation'));
    });
});

describe('domain.add', () => {
    it('normalise l’hôte, rend les enregistrements, et journalise', async () => {
        const repo = memoryRepo();
        const { ctx, audits } = context(repo);
        const out = (await run('domain.add', ctx, { feature: 'x-domyes', host: ' Rdv.Exemple.FR. ' })) as {
            domain: { host: string; ownership: { name: string; value: string }; records: unknown[] };
        };
        assert.equal(out.domain.host, 'rdv.exemple.fr');
        assert.equal(out.domain.ownership.name, '_deveye.rdv.exemple.fr');
        assert.match(out.domain.ownership.value, /^deveye-domyes=[0-9a-f]{32}$/);
        assert.deepEqual(out.domain.records, [{ type: 'CNAME', name: 'rdv.exemple.fr', value: 'deveye.test' }]);
        assert.deepEqual(audits, ['domain.add']);
    });

    it('refuse ce qui n’est pas un nom d’hôte', async () => {
        const { ctx } = context(memoryRepo());
        await assert.rejects(
            run('domain.add', ctx, { feature: 'x-domyes', host: 'https://exemple.fr/x' }),
            code('validation')
        );
    });

    it('refuse un hôte déjà pris, même par un autre espace', async () => {
        const repo = memoryRepo();
        await run('domain.add', context(repo, { workspaceId: 2 }).ctx, { feature: 'x-domyes', host: 'exemple.fr' });
        await assert.rejects(
            run('domain.add', context(repo).ctx, { feature: 'x-domyes', host: 'exemple.fr' }),
            code('conflict')
        );
    });
});

describe('domain.list et domain.remove', () => {
    it('ne montre que l’espace actif, avec le compte d’usage du module', async () => {
        const repo = memoryRepo();
        await run('domain.add', context(repo).ctx, { feature: 'x-domyes', host: 'un.exemple.fr' });
        await run('domain.add', context(repo, { workspaceId: 2 }).ctx, {
            feature: 'x-domyes',
            host: 'deux.exemple.fr'
        });
        const out = (await run('domain.list', context(repo).ctx, { feature: 'x-domyes' })) as {
            domains: { host: string; useCount: number }[];
        };
        assert.deepEqual(
            out.domains.map((d) => [d.host, d.useCount]),
            [['un.exemple.fr', 3]]
        );
    });

    it('un domaine d’un autre espace est introuvable', async () => {
        const repo = memoryRepo();
        await run('domain.add', context(repo, { workspaceId: 2 }).ctx, { feature: 'x-domyes', host: 'exemple.fr' });
        await assert.rejects(
            run('domain.remove', context(repo).ctx, { feature: 'x-domyes', id: 1 }),
            code('not_found')
        );
    });

    it('prévient le module avant de supprimer, et garde la ligne s’il refuse', async () => {
        const repo = memoryRepo();
        const { ctx } = context(repo);
        await run('domain.add', ctx, { feature: 'x-domyes', host: 'exemple.fr' });
        refuseRemoval = true;
        await assert.rejects(run('domain.remove', ctx, { feature: 'x-domyes', id: 1 }), /encore désigné/);
        assert.equal(repo.rows.length, 1);
        refuseRemoval = false;
        await run('domain.remove', ctx, { feature: 'x-domyes', id: 1 });
        assert.equal(repo.rows.length, 0);
        assert.equal(removed.at(-1)?.host, 'exemple.fr');
    });
});

describe('domain.* : les domaines web et l’offre', () => {
    const limited = (limit: number): AccountPlan => ({
        id: 'free',
        label: 'Gratuite',
        limits: { 'domains.hosts': limit },
        priority: false
    });

    it('la liste dit le mode des certificats et l’usage, seulement pour des domaines web', async () => {
        const repo = memoryRepo();
        plan = limited(3);
        await run('domain.add', context(repo).ctx, { feature: 'x-domweb', host: 'rdv.exemple.fr' });
        await run('domain.add', context(repo, { workspaceId: 2 }).ctx, {
            feature: 'x-domweb',
            host: 'autre.exemple.fr'
        });
        const web = (await run('domain.list', context(repo).ctx, { feature: 'x-domweb' })) as {
            https: string | null;
            quota: { used: number; limit: number } | null;
        };
        assert.equal(web.https, 'manual');
        assert.deepEqual(web.quota, { used: 2, limit: 3 });

        const other = (await run('domain.list', context(repo).ctx, { feature: 'x-domyes' })) as {
            https: string | null;
            quota: unknown;
        };
        assert.equal(other.https, null);
        assert.equal(other.quota, null);
        plan = null;
    });

    it('une offre à 0 refuse le premier domaine web, et laisse passer les autres domaines', async () => {
        const repo = memoryRepo();
        plan = limited(0);
        await assert.rejects(
            run('domain.add', context(repo).ctx, { feature: 'x-domweb', host: 'rdv.exemple.fr' }),
            code('quota_exceeded')
        );
        await assert.doesNotReject(
            run('domain.add', context(repo).ctx, { feature: 'x-domyes', host: 'mx.exemple.fr' })
        );
        plan = null;
    });

    it('pile à la limite passe, au-delà refuse, tous espaces du propriétaire confondus', async () => {
        const repo = memoryRepo();
        plan = limited(2);
        await run('domain.add', context(repo).ctx, { feature: 'x-domweb', host: 'un.exemple.fr' });
        await run('domain.add', context(repo, { workspaceId: 2 }).ctx, {
            feature: 'x-domweb',
            host: 'deux.exemple.fr'
        });
        await assert.rejects(
            run('domain.add', context(repo).ctx, { feature: 'x-domweb', host: 'trois.exemple.fr' }),
            code('quota_exceeded')
        );
        plan = null;
    });

    it('un nom déjà compté pour une autre fonctionnalité web ne compte pas deux fois', async () => {
        const repo = memoryRepo();
        plan = limited(1);
        await run('domain.add', context(repo).ctx, { feature: 'x-domweb', host: 'pages.exemple.fr' });
        await assert.doesNotReject(
            run('domain.add', context(repo).ctx, { feature: 'x-domsite', host: 'pages.exemple.fr' })
        );
        plan = null;
    });
});
