import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { z, ZodType } from 'zod';

import {
    audienceCount,
    audienceFunnelAdd,
    audienceFunnelList,
    audienceGet,
    audienceList,
    audienceReorder,
    audienceSiteAdd,
    audienceSiteRemove,
    audienceSiteRotateKey,
    audienceSiteUpdate,
    audienceSummary
} from '../contracts/commands';
import type { AudienceFunnelRow, AudienceFunnelStepRow, AudienceSiteRow } from '../contracts/domain';
import { PROJECTS_USAGE_PROVIDER, type ProjectsUsageProvider } from '@deveye/types/sdk';
import { FeatureError, type SdkFeatureContext } from '@deveye/types/sdk/server';
import { createTestContext } from '@deveye/types/sdk/testing';

import { audienceHandlers } from './handlers';
import { dayKey, labelRef } from './normalize';
import type { AudienceRepo, AudienceSiteWithStatsRow } from './repo';
import type { AudienceIngest } from './service';
import { setIngest } from './_shared';

/**
 * Les handlers du module, sur le harnais du SDK. On tient ce qui ne lève nulle
 * part quand ça se dérègle : restrictions par élément, partage inter-espaces,
 * contrat de Projets absent qui vaut zéro, adresse de la balise venue du
 * serveur, cache de l'ingestion vidé par les mutations, ménage à la
 * suppression, et marches d'entonnoir normalisées comme à l'ingestion.
 */

/** Le handler d'un contrat, typé par ce contrat (le registre est hétérogène). */
function handlerFor<C extends { command: string; input: ZodType; output: ZodType }>(contract: C) {
    const def = audienceHandlers.find((h) => h.command === contract.command);
    assert.ok(def, `handler ${contract.command} manquant`);
    return def.handler as (
        ctx: SdkFeatureContext<AudienceRepo>,
        input: z.output<C['input']>
    ) => Promise<z.input<C['output']>>;
}

const failsWith =
    (code: FeatureError['code']) =>
    (e: unknown): boolean =>
        e instanceof FeatureError && e.code === code;

interface FakeRepo extends AudienceRepo {
    sites: AudienceSiteRow[];
    funnels: AudienceFunnelRow[];
    steps: AudienceFunnelStepRow[];
}

/** Un site en base, tel que le vrai dépôt le rendrait (contenu en clair : le harnais chiffre à l'identité). */
function site(over: Partial<AudienceSiteRow> & { id: number; workspace_id: number }): AudienceSiteRow {
    return {
        // `pk_` + 24 caractères : la longueur que le schéma exige.
        public_key: `pk_${String(over.id).padStart(24, '0')}`,
        name_ref: `ref-${over.id}`,
        platform: 'web',
        visitor_mode: 'anonymous',
        origins: 'exemple.fr',
        active: 1,
        retention_days: 180,
        forms_auto: 0,
        submission_ip_quota: 5,
        form_hourly_quota: 200,
        event_ip_quota: 0,
        sort_order: over.id,
        last_event_at: null,
        content: JSON.stringify({ name: `Site ${over.id}`, description: '' }),
        created: 1,
        ...over
    };
}

/**
 * Un dépôt en mémoire, même contrat que le vrai. `projections` reproduit
 * `item_shares` (`siteId → espaces où il est projeté`), ce qui donne à
 * `listVisible` / `findVisible` leur seconde branche ; le harnais doit le dire
 * en écho pour que `ctx.sharing.scope()` connaisse le domicile. La rétention
 * est simulée : dix visites à la première marche, quatre à la seconde, zéro
 * dès qu'une marche n'a pas de libellé.
 */
function fakeRepo(projections: Record<number, number[]> = {}): FakeRepo {
    let seq = 100;
    const sites: AudienceSiteRow[] = [];
    const funnels: AudienceFunnelRow[] = [];
    const steps: AudienceFunnelStepRow[] = [];
    const visible = (s: AudienceSiteRow, workspaceId: number) =>
        s.workspace_id === workspaceId || (projections[s.id] ?? []).includes(workspaceId);
    const withStats = (s: AudienceSiteRow): AudienceSiteWithStatsRow => ({ ...s, views_24h: 12, visitors_24h: 3 });
    const unused = async () => {
        throw new Error('non attendu ici');
    };
    return {
        sites,
        funnels,
        steps,
        list: async (workspaceId) => sites.filter((s) => s.workspace_id === workspaceId).map(withStats),
        listVisible: async (workspaceId) => sites.filter((s) => visible(s, workspaceId)).map(withStats),
        find: async (id, workspaceId) => sites.find((s) => s.id === id && s.workspace_id === workspaceId) ?? null,
        findVisible: async (id, workspaceId) => sites.find((s) => s.id === id && visible(s, workspaceId)) ?? null,
        findWithStats: async (id, workspaceId) => {
            const s = sites.find((x) => x.id === id && x.workspace_id === workspaceId);
            return s ? withStats(s) : null;
        },
        findByName: async (workspaceId, nameRef) =>
            sites.find((s) => s.workspace_id === workspaceId && s.name_ref === nameRef) ?? null,
        count: async (workspaceId) => sites.filter((s) => s.workspace_id === workspaceId).length,
        async create(input) {
            const created = site({
                id: ++seq,
                workspace_id: input.workspaceId,
                public_key: input.publicKey,
                name_ref: input.nameRef,
                platform: input.platform,
                visitor_mode: input.visitorMode,
                origins: input.origins,
                active: input.active ? 1 : 0,
                retention_days: input.retentionDays,
                content: input.content
            });
            sites.push(created);
            return created;
        },
        async update(id, workspaceId, input) {
            const s = sites.find((x) => x.id === id && x.workspace_id === workspaceId);
            if (!s) return null;
            Object.assign(s, {
                name_ref: input.nameRef,
                platform: input.platform,
                visitor_mode: input.visitorMode,
                origins: input.origins,
                active: input.active ? 1 : 0,
                retention_days: input.retentionDays,
                content: input.content
            });
            return s;
        },
        async setPublicKey(id, workspaceId, publicKey) {
            const s = sites.find((x) => x.id === id && x.workspace_id === workspaceId);
            if (s) s.public_key = publicKey;
        },
        async remove(id, workspaceId) {
            const i = sites.findIndex((s) => s.id === id && s.workspace_id === workspaceId);
            if (i === -1) return false;
            sites.splice(i, 1);
            return true;
        },
        async reorder(workspaceId, ids) {
            ids.forEach((id, i) => {
                const s = sites.find((x) => x.id === id && x.workspace_id === workspaceId);
                if (s) s.sort_order = i;
            });
        },
        metrics: unused,
        returningVisitors: unused,
        points: unused,
        breakdown: unused,
        activity: unused,
        liveVisitors: unused,
        livePages: unused,
        recentDailyViews: unused,
        listFunnels: async (siteId) => funnels.filter((f) => f.site_id === siteId),
        listFunnelSteps: async (siteId) => steps.filter((s) => s.site_id === siteId),
        findFunnelInWorkspace: async (funnelId, workspaceId) => {
            const f = funnels.find((x) => x.id === funnelId);
            if (!f) return null;
            const home = sites.find((s) => s.id === f.site_id);
            return home && home.workspace_id === workspaceId ? f : null;
        },
        findFunnelByName: async (siteId, nameRef) =>
            funnels.find((f) => f.site_id === siteId && f.name_ref === nameRef) ?? null,
        countFunnels: async (siteId) => funnels.filter((f) => f.site_id === siteId).length,
        async createFunnel(input) {
            const id = ++seq;
            funnels.push({
                id,
                site_id: input.siteId,
                name_ref: input.nameRef,
                sort_order: 0,
                content: input.content,
                created: 1
            });
            return id;
        },
        async renameFunnel(funnelId, nameRef, content) {
            const f = funnels.find((x) => x.id === funnelId);
            if (f) Object.assign(f, { name_ref: nameRef, content });
        },
        async removeFunnel(funnelId) {
            const i = funnels.findIndex((f) => f.id === funnelId);
            if (i === -1) return false;
            funnels.splice(i, 1);
            return true;
        },
        async replaceFunnelSteps(funnelId, siteId, next) {
            for (let i = steps.length - 1; i >= 0; i--) if (steps[i].funnel_id === funnelId) steps.splice(i, 1);
            next.forEach((step, position) => {
                steps.push({
                    id: ++seq,
                    funnel_id: funnelId,
                    site_id: siteId,
                    position,
                    match_kind: step.kind,
                    label_ref: step.labelRef,
                    content: step.content
                });
            });
        },
        // Seuls les libellés « déjà émis » se résolvent : ici, `/tarifs` et
        // l'événement `devis` ; tout autre condensé reste inconnu.
        resolveLabels: async (_siteId, refs) =>
            new Map(
                refs
                    .filter((r) => r.labelRef === labelRef('/tarifs') || r.labelRef === labelRef('devis'))
                    .map((r, i) => [`${r.kind}:${r.labelRef}`, i + 1])
            ),
        retention: async (_siteId, resolved) => resolved.map((s, i) => (s.labelId === null ? 0 : 10 - i * 6)),
        findByPublicKey: unused,
        resolveLabel: unused,
        findOpenSession: unused,
        createSession: unused,
        touchSession: unused,
        setSessionIdentity: unused,
        insertEvents: unused,
        touchSite: unused,
        listForMaintenance: unused,
        rollupDay: unused,
        pruneEvents: unused,
        pruneSessions: unused,
        pruneOrphanLabels: unused,
        // Les retours ont leur propre fichier (`forms.test.ts`) et leur propre
        // dépôt en mémoire : rien ici ne les appelle.
        listForms: unused,
        findForm: unused,
        findFormByName: unused,
        countForms: unused,
        updateForm: unused,
        removeForm: unused,
        clearForm: unused,
        createForm: unused,
        closeForm: unused,
        countSubmissionsSince: unused,
        insertSubmission: unused,
        touchForm: unused,
        bumpFormSubmissions: unused,
        resolveFormLabel: unused,
        findFormLabel: unused,
        countAnswerValues: unused,
        bumpAnswer: unused,
        listSubmissions: unused,
        findSubmission: unused,
        removeSubmission: unused,
        readAnswers: unused,
        feedbackStats: unused,
        dailyPoints: unused
    };
}

function seed(repo: FakeRepo, ...seeded: AudienceSiteRow[]): FakeRepo {
    repo.sites.push(...seeded);
    return repo;
}

/** Le contrat de Projets, tel que l'app (ou son module) l'offre : l'espace 1 relie le site 1 à deux projets. */
function projectsProvider(): ProjectsUsageProvider {
    return {
        usageOf: async (feature, itemId, workspaceId) =>
            feature === 'audience' && itemId === 1 && workspaceId === 1
                ? [
                      { projectId: 5, title: 'Boutique', status: 'active' },
                      { projectId: 6, title: 'Sans titre', status: 'draft' }
                  ]
                : [],
        countByItem: async (feature, workspaceId) =>
            feature === 'audience' && workspaceId === 1 ? new Map([[1, 2]]) : new Map(),
        detach: async () => 0,
        recordEvent: async () => undefined,
        applyVersion: async () => undefined
    };
}

/** L'ingestion factice : un handler lui demande d'oublier son cache, on compte. */
function mountIngest(): { invalidated: number } {
    const fake = {
        invalidated: 0,
        invalidate() {
            fake.invalidated++;
        }
    };
    setIngest(fake as unknown as AudienceIngest);
    return fake;
}

afterEach(() => setIngest(null));

const body = {
    name: 'Vitrine',
    description: 'Le site public',
    platform: 'web' as const,
    visitorMode: 'anonymous' as const,
    origins: ['https://Exemple.fr/', 'www.exemple.fr:443', ''],
    active: true,
    retentionDays: 90,
    formsAuto: false,
    submissionIpQuota: 5,
    formHourlyQuota: 200,
    eventIpQuota: 0
};

describe('audience.count et audience.list', () => {
    it('retirent un site masqué pour ce rôle et comptent les projets par le contrat', async () => {
        const repo = seed(
            fakeRepo(),
            site({ id: 1, workspace_id: 1 }),
            site({ id: 2, workspace_id: 1 }),
            site({ id: 3, workspace_id: 1 })
        );
        const ctx = createTestContext({
            repo,
            itemRestrictions: { 3: 'none' },
            providers: { [PROJECTS_USAGE_PROVIDER]: projectsProvider() }
        });

        const listed = await handlerFor(audienceList)(ctx, {});
        assert.deepEqual(
            listed.sites.map((s) => [s.id, s.name, s.foreign, s.projectCount, s.views24h, s.origins]),
            [
                [1, 'Site 1', false, 2, 12, ['exemple.fr']],
                [2, 'Site 2', false, 0, 12, ['exemple.fr']]
            ]
        );
        // La carte compte ce que la liste montre, restrictions déduites.
        assert.deepEqual(await handlerFor(audienceCount)(ctx, {}), { count: 2 });
    });

    it('sans contrat de Projets, le compte vaut zéro plutôt qu’une erreur', async () => {
        const repo = seed(fakeRepo(), site({ id: 1, workspace_id: 1 }));
        const listed = await handlerFor(audienceList)(createTestContext({ repo }), {});
        assert.equal(listed.sites[0].projectCount, 0);
    });
});

describe('le partage inter-espaces', () => {
    it("liste une projection avec sa pastille `foreign`, sous le codec de son espace d'origine", async () => {
        // Le site 7 vit dans l'espace 42 et se projette vers l'espace 1.
        const repo = seed(fakeRepo({ 7: [1] }), site({ id: 7, workspace_id: 42 }));
        const ctx = createTestContext({ repo, workspaceId: 1, shares: { 7: 42 } });

        // Le codec est demandé pour la ligne : le harnais rend l'identité,
        // l'appel est ce qui se vérifie.
        const asked: number[] = [];
        const scope = ctx.sharing.scope;
        ctx.sharing = {
            ...ctx.sharing,
            scope: async () => {
                const real = await scope();
                return {
                    ...real,
                    cipherFor: (itemId) => {
                        asked.push(Number(itemId));
                        return real.cipherFor(itemId);
                    }
                };
            }
        };
        const listed = await handlerFor(audienceList)(ctx, {});
        assert.deepEqual(
            listed.sites.map((s) => [s.id, s.foreign]),
            [[7, true]]
        );
        assert.deepEqual(asked, [7]);
    });

    it('refuse de régler, de renouveler ou de supprimer une projection depuis la fenêtre', async () => {
        const repo = seed(fakeRepo({ 7: [1] }), site({ id: 7, workspace_id: 42 }));
        const ctx = createTestContext({ repo, workspaceId: 1, shares: { 7: 42 } });
        const ingest = mountIngest();
        await assert.rejects(handlerFor(audienceSiteUpdate)(ctx, { siteId: 7, ...body }), failsWith('forbidden'));
        await assert.rejects(handlerFor(audienceSiteRotateKey)(ctx, { siteId: 7 }), failsWith('forbidden'));
        await assert.rejects(handlerFor(audienceSiteRemove)(ctx, { siteId: 7 }), failsWith('forbidden'));
        assert.equal(repo.sites.length, 1);
        assert.equal(repo.sites[0].name_ref, 'ref-7');
        assert.equal(ingest.invalidated, 0);
    });
});

describe('audience.get', () => {
    it('rend le site, les projets qui le suivent (par le contrat) et l’adresse de la balise du serveur', async () => {
        const repo = seed(fakeRepo(), site({ id: 1, workspace_id: 1 }));
        const ctx = createTestContext({
            repo,
            origins: { app: 'https://deveye.exemple.fr', public: 'https://t.exemple.fr' },
            providers: { [PROJECTS_USAGE_PROVIDER]: projectsProvider() }
        });

        const out = await handlerFor(audienceGet)(ctx, { siteId: 1 });
        assert.equal(out.site.name, 'Site 1');
        assert.equal(out.site.projectCount, 2);
        assert.deepEqual(
            out.usage.map((u) => [u.projectId, u.title, u.status]),
            [
                [5, 'Boutique', 'active'],
                [6, 'Sans titre', 'draft']
            ]
        );
        // L'origine publique du serveur, jamais celle de l'app ni du navigateur.
        assert.equal(out.ingestOrigin, 'https://t.exemple.fr');
    });

    it('répond `not_found` pour un site d’un autre espace non projeté', async () => {
        const repo = seed(fakeRepo(), site({ id: 7, workspace_id: 42 }));
        await assert.rejects(
            handlerFor(audienceGet)(createTestContext({ repo, workspaceId: 1 }), { siteId: 7 }),
            failsWith('not_found')
        );
    });
});

describe('audience.siteAdd et audience.siteUpdate', () => {
    it('déclare un site chiffré à l’étage ouvert, origines normalisées, et vide le cache de l’ingestion', async () => {
        const repo = fakeRepo();
        const ctx = createTestContext({ repo });
        const ingest = mountIngest();

        const out = await handlerFor(audienceSiteAdd)(ctx, body);
        assert.equal(out.site.name, 'Vitrine');
        assert.equal(out.site.projectCount, 0);
        assert.equal(out.site.foreign, false);
        // Un hôte par origine, en minuscules, sans protocole, port ni barre,
        // dédoublonné et sans les vides : ce à quoi l'`Origin` sera confronté.
        assert.deepEqual(out.site.origins, ['exemple.fr', 'www.exemple.fr']);
        // La clé est choisie par le serveur, à la longueur de la colonne.
        assert.match(out.site.publicKey, /^pk_[A-Za-z0-9_-]{24}$/);
        // Le harnais chiffre à l'identité : le nom est dans le blob.
        assert.equal(repo.sites[0].content, JSON.stringify({ name: 'Vitrine', description: 'Le site public' }));
        assert.equal(ingest.invalidated, 1);
        assert.deepEqual(
            ctx.recorded.audits.map((a) => a.action),
            ['audience.siteAdd']
        );

        // Le même nom dans le même espace est refusé.
        await assert.rejects(handlerFor(audienceSiteAdd)(ctx, { ...body, name: ' vitrine ' }), failsWith('validation'));
        assert.equal(repo.sites.length, 1);
    });

    it('règle un site chez lui, et vide le cache de l’ingestion', async () => {
        const repo = seed(fakeRepo(), site({ id: 1, workspace_id: 1 }));
        const ingest = mountIngest();
        const out = await handlerFor(audienceSiteUpdate)(createTestContext({ repo }), {
            siteId: 1,
            ...body,
            active: false,
            visitorMode: 'persistent'
        });
        assert.deepEqual([out.site.name, out.site.active, out.site.visitorMode], ['Vitrine', false, 'persistent']);
        assert.equal(repo.sites[0].active, 0);
        assert.equal(ingest.invalidated, 1);
    });
});

describe('audience.siteRotateKey, audience.siteRemove et audience.reorder', () => {
    it('renouvelle la clé et fait oublier l’ancienne à l’ingestion', async () => {
        const repo = seed(fakeRepo(), site({ id: 1, workspace_id: 1 }));
        const ctx = createTestContext({ repo });
        const ingest = mountIngest();
        const before = repo.sites[0].public_key;

        const out = await handlerFor(audienceSiteRotateKey)(ctx, { siteId: 1 });
        assert.notEqual(out.site.publicKey, before);
        assert.equal(repo.sites[0].public_key, out.site.publicKey);
        assert.equal(ingest.invalidated, 1);
        assert.equal(ctx.recorded.audits[0].action, 'audience.siteRotateKey');
    });

    it('supprimer fait le ménage des projections, restrictions et route, et vide le cache', async () => {
        const repo = seed(fakeRepo(), site({ id: 1, workspace_id: 1 }));
        const ctx = createTestContext({ repo });
        const ingest = mountIngest();
        assert.deepEqual(await handlerFor(audienceSiteRemove)(ctx, { siteId: 1 }), { ok: true });
        assert.deepEqual(repo.sites, []);
        assert.deepEqual(ctx.forgotten, ['1']);
        assert.equal(ingest.invalidated, 1);
        assert.equal(ctx.recorded.audits[0].action, 'audience.siteRemove');

        await assert.rejects(handlerFor(audienceSiteRemove)(ctx, { siteId: 1 }), failsWith('not_found'));
    });

    it('sans ingestion montée, les mutations passent quand même', async () => {
        const repo = seed(fakeRepo(), site({ id: 1, workspace_id: 1 }));
        const out = await handlerFor(audienceSiteRotateKey)(createTestContext({ repo }), { siteId: 1 });
        assert.match(out.site.publicKey, /^pk_/);
    });

    it('range les sites dans l’ordre donné, sans toucher au cache de l’ingestion', async () => {
        const repo = seed(fakeRepo(), site({ id: 1, workspace_id: 1 }), site({ id: 2, workspace_id: 1 }));
        const ingest = mountIngest();
        assert.deepEqual(await handlerFor(audienceReorder)(createTestContext({ repo }), { siteIds: [2, 1] }), {
            ok: true
        });
        assert.deepEqual(
            repo.sites.map((s) => [s.id, s.sort_order]),
            [
                [1, 1],
                [2, 0]
            ]
        );
        assert.equal(ingest.invalidated, 0);
    });
});

describe('les entonnoirs', () => {
    it('définit un entonnoir aux marches normalisées comme à l’ingestion, puis le relit avec ses chiffres', async () => {
        const repo = seed(fakeRepo(), site({ id: 1, workspace_id: 1 }));
        const ctx = createTestContext({ repo });

        const added = await handlerFor(audienceFunnelAdd)(ctx, {
            siteId: 1,
            name: 'Devis',
            steps: [
                { kind: 'path', value: '/tarifs/' },
                { kind: 'event', value: 'devis' },
                { kind: 'path', value: '/merci?utm=x' }
            ]
        });
        // `/tarifs/` est rangé `/tarifs`, comme l'ingestion l'aurait fait :
        // c'est ce qui permet à la marche de retrouver son libellé.
        assert.deepEqual(
            repo.steps.map((s) => [s.position, s.match_kind, s.content, s.label_ref === labelRef(s.content)]),
            [
                [0, 'path', '/tarifs', true],
                [1, 'event', 'devis', true],
                [2, 'path', '/merci', true]
            ]
        );
        assert.equal(ctx.recorded.audits[0].action, 'audience.funnelAdd');

        const listed = await handlerFor(audienceFunnelList)(ctx, { siteId: 1, range: '7d' });
        assert.deepEqual(
            listed.funnels.map((f) => [f.id, f.name, f.steps.map((s) => [s.kind, s.value, s.sessions])]),
            [
                [
                    added.funnelId,
                    'Devis',
                    [
                        ['path', '/tarifs', 10],
                        ['event', 'devis', 4],
                        // Jamais émise : zéro, ce qui est la vérité.
                        ['path', '/merci', 0]
                    ]
                ]
            ]
        );
    });

    it('un entonnoir se définit chez le site, jamais depuis une fenêtre', async () => {
        const repo = seed(fakeRepo({ 7: [1] }), site({ id: 7, workspace_id: 42 }));
        const ctx = createTestContext({ repo, workspaceId: 1, shares: { 7: 42 } });
        await assert.rejects(
            handlerFor(audienceFunnelAdd)(ctx, {
                siteId: 7,
                name: 'Devis',
                steps: [
                    { kind: 'path', value: '/a' },
                    { kind: 'path', value: '/b' }
                ]
            }),
            failsWith('forbidden')
        );
        assert.deepEqual(repo.funnels, []);
    });
});

describe('audience.summary', () => {
    it('reprend les deux derniers jours sur les faits, l’agrégat n’étant refait qu’à l’heure', async () => {
        const repo = seed(fakeRepo(), site({ id: 1, workspace_id: 1, last_event_at: 1_700_000_000 }));
        const now = Math.floor(Date.now() / 1000);
        const dayOf = (back: number) => dayKey(now - back * 86400);
        // L'agrégat tel que le ménage l'a laissé il y a une heure : hier et
        // aujourd'hui y sont en retard, les jours révolus sont justes.
        repo.dailyPoints = async () => [
            { day: dayOf(6), views: 7 },
            { day: dayOf(1), views: 40 },
            { day: dayOf(0), views: 99 }
        ];
        // Les faits, eux, sont à la seconde : aujourd'hui a bougé depuis, et hier
        // n'a finalement rien reçu.
        repo.recentDailyViews = async () => [{ day: dayOf(0), views: 412 }];
        repo.feedbackStats = async () => ({ forms: 0, submissions: 0, last7d: 0, lastAt: null });

        const summary = await handlerFor(audienceSummary)(createTestContext({ repo }), { siteId: 1 });
        assert.deepEqual(
            summary.traffic.days.map((d) => d.views),
            [7, 0, 0, 0, 0, 0, 412]
        );
    });
});
