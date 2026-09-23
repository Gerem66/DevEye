import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    AUDIENCE_MAX_FORMS,
    type AudienceFormField,
    type AudienceFormLabelRow,
    type AudienceFormRow,
    type AudienceSiteRow,
    type AudienceSubmissionRow
} from '../contracts/domain';
import { AUDIENCE_ITEMS_PROVIDER, type AudienceItemsProvider } from '@deveye/types/sdk';
import { createTestServiceDeps } from '@deveye/types/sdk/testing';

import { countAnswers } from './answers';
import { dayKey, monthKey } from './normalize';
import { nameRef } from './_shared';
import { serverEntry } from './index';
import type { AudienceRepo, NewSessionInput, PendingEventRow } from './repo';
import { AudienceIngest, type IngestRequest, type SubmitRequest } from './service';

/**
 * L'ingestion du module, sur le harnais de service du SDK. Aucune horloge ni
 * réseau à simuler : le dépôt en mémoire retient ce qu'on lui écrit et les deux
 * tickers se battent à la main. On tient l'événement accepté qui entre en base
 * à la vidange, le refus qui n'écrit rien, le direct coalescé, `invalidate` qui
 * fait relire un site, le ménage qui agrège puis élague, et le sel des
 * visiteurs stable d'une instance à l'autre.
 *
 * Les retours empruntent la même porte mais pas la file : on tient qu'ils sont
 * écrits avant que `submit` ne rende la main, que le formulaire naît de sa
 * première réception, et que les compteurs de répartition suivent.
 */

interface FakeRepo extends AudienceRepo {
    sites: AudienceSiteRow[];
    sessions: (NewSessionInput & { id: number; touched: number; identityId: number | null })[];
    events: PendingEventRow[];
    labels: Map<string, number>;
    touchedSites: [number, number][];
    rollups: [number, number, number, number][];
    pruned: { events: [number, number][]; sessions: [number, number][]; labels: number[] };
    forms: AudienceFormRow[];
    submissions: AudienceSubmissionRow[];
    formLabels: AudienceFormLabelRow[];
    /** `formId:fieldId:valueId` → compte. */
    answers: Map<string, number>;
    /** `workspaceId:mois` → événements, la table de consommation en mémoire. */
    usage: Map<string, number>;
    /** `siteId:ipRef` → échéance, les provenances écartées. */
    bans: Map<string, number>;
}

const KEY = 'pk_000000000000000000000001';
const UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0';

function site(over: Partial<AudienceSiteRow> = {}): AudienceSiteRow {
    return {
        id: 1,
        workspace_id: 1,
        public_key: KEY,
        name_ref: 'ref-1',
        platform: 'web',
        visitor_mode: 'anonymous',
        origins: 'exemple.fr',
        active: 1,
        retention_days: 30,
        forms_auto: 0,
        submission_ip_quota: 5,
        submission_ban_quota: 60,
        form_hourly_quota: 200,
        event_ip_quota: 0,
        sort_order: 0,
        last_event_at: null,
        content: JSON.stringify({ name: 'Vitrine', description: '' }),
        created: 1,
        ...over
    };
}

/** Un dépôt en mémoire ; le harnais chiffre à l'identité, donc les libellés sont en clair. */
function fakeRepo(sites: AudienceSiteRow[]): FakeRepo {
    let seq = 0;
    const usage = new Map<string, number>();
    const repo: FakeRepo = {
        sites,
        sessions: [],
        events: [],
        labels: new Map(),
        touchedSites: [],
        rollups: [],
        pruned: { events: [], sessions: [], labels: [] },
        forms: [],
        submissions: [],
        formLabels: [],
        answers: new Map(),
        usage,
        bans: new Map(),
        monthlyEvents: async (ids: readonly number[], month: number) =>
            ids.reduce((total, id) => total + (usage.get(`${id}:${month}`) ?? 0), 0),
        bumpUsage: async (workspaceId: number, month: number, delta: number) => {
            const key = `${workspaceId}:${month}`;
            usage.set(key, (usage.get(key) ?? 0) + delta);
        },
        countInWorkspaces: async (ids: readonly number[]) => sites.filter((r) => ids.includes(r.workspace_id)).length,
        list: unused,
        listVisible: unused,
        find: async (id, workspaceId) => sites.find((s) => s.id === id && s.workspace_id === workspaceId) ?? null,
        findVisible: async (id, workspaceId) =>
            sites.find((s) => s.id === id && s.workspace_id === workspaceId) ?? null,
        findWithStats: unused,
        findByName: unused,
        count: unused,
        create: unused,
        update: unused,
        setPublicKey: unused,
        remove: unused,
        reorder: unused,
        metrics: unused,
        returningVisitors: unused,
        points: unused,
        breakdown: unused,
        activity: unused,
        liveVisitors: unused,
        livePages: unused,
        recentDailyViews: unused,
        listFunnels: unused,
        listFunnelSteps: unused,
        findFunnelInWorkspace: unused,
        findFunnelByName: unused,
        countFunnels: unused,
        createFunnel: unused,
        renameFunnel: unused,
        removeFunnel: unused,
        replaceFunnelSteps: unused,
        resolveLabels: unused,
        retention: unused,
        findByPublicKey: async (publicKey) => sites.find((s) => s.public_key === publicKey) ?? null,
        // Comme `ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)` : la même
        // valeur rend le même identifiant, le contenu n'est jamais réécrit.
        async resolveLabel(siteId, kind, _labelRef, content) {
            const key = `${siteId}:${kind}:${content}`;
            const hit = repo.labels.get(key);
            if (hit !== undefined) return hit;
            const id = ++seq;
            repo.labels.set(key, id);
            return id;
        },
        findOpenSession: async (siteId, visitorRef, since) => {
            const open = repo.sessions.find((s) => s.siteId === siteId && s.visitorRef === visitorRef && s.at >= since);
            return open ? { id: open.id, views: open.touched, identity_id: open.identityId } : null;
        },
        async createSession(input) {
            const id = ++seq;
            repo.sessions.push({ ...input, id, touched: 0 });
            return id;
        },
        async touchSession(id, _at, viewsDelta) {
            const s = repo.sessions.find((x) => x.id === id);
            if (s) s.touched += viewsDelta;
        },
        async setSessionIdentity(id, identityId) {
            const s = repo.sessions.find((x) => x.id === id);
            if (s) s.identityId = identityId;
        },
        async insertEvents(rows) {
            repo.events.push(...rows);
        },
        async touchSite(siteId, at) {
            repo.touchedSites.push([siteId, at]);
        },
        listForMaintenance: async () =>
            sites.map((s) => ({ id: s.id, workspace_id: s.workspace_id, retention_days: s.retention_days })),
        async rollupDay(siteId, day, from, to) {
            repo.rollups.push([siteId, day, from, to]);
        },
        async pruneEvents(siteId, before) {
            repo.pruned.events.push([siteId, before]);
            return 3;
        },
        async pruneSessions(siteId, before) {
            repo.pruned.sessions.push([siteId, before]);
            return 0;
        },
        listForms: async (siteId) => repo.forms.filter((f) => f.site_id === siteId),
        findForm: async (formId) => repo.forms.find((f) => f.id === formId) ?? null,
        findFormByName: async (siteId, nameRef) =>
            repo.forms.find((f) => f.site_id === siteId && f.name_ref === nameRef) ?? null,
        countForms: async (siteId) => repo.forms.filter((f) => f.site_id === siteId).length,
        async updateForm(input) {
            const f = repo.forms.find((x) => x.id === input.formId);
            if (f) Object.assign(f, { name_ref: input.nameRef, content: input.content, is_open: input.open ? 1 : 0 });
        },
        async removeForm(formId) {
            const i = repo.forms.findIndex((f) => f.id === formId);
            if (i === -1) return false;
            repo.forms.splice(i, 1);
            return true;
        },
        async clearForm(formId) {
            const before = repo.submissions.length;
            repo.submissions = repo.submissions.filter((b) => b.form_id !== formId);
            repo.formLabels = repo.formLabels.filter((l) => l.form_id !== formId);
            for (const key of [...repo.answers.keys()]) {
                if (key.startsWith(`${formId}:`)) repo.answers.delete(key);
            }
            const f = repo.forms.find((x) => x.id === formId);
            if (f) Object.assign(f, { submissions: 0, last_at: null });
            return before - repo.submissions.length;
        },
        async createForm(input) {
            const id = ++seq;
            repo.forms.push({
                id,
                site_id: input.siteId,
                name_ref: input.nameRef,
                mode: input.mode,
                form_schema: input.formSchema,
                is_open: 1,
                closed_at: null,
                closed_reason: null,
                submissions: 0,
                last_at: null,
                sort_order: input.sortOrder,
                content: input.content,
                created: 1
            });
            return id;
        },
        async closeForm(formId, at, reason) {
            const f = repo.forms.find((x) => x.id === formId);
            if (f) Object.assign(f, { is_open: 0, closed_at: at, closed_reason: reason });
        },
        async countSubmissionsSince(formId, ipRef, since) {
            return repo.submissions.filter(
                (b) => b.form_id === formId && b.ts >= since && (ipRef === null || b.ip_ref === ipRef)
            ).length;
        },
        async countSiteSubmissionsSince(siteId, ipRef, since) {
            return repo.submissions.filter((b) => b.site_id === siteId && b.ts >= since && b.ip_ref === ipRef).length;
        },
        async banUntil(siteId, ipRef) {
            return repo.bans.get(`${siteId}:${ipRef}`) ?? null;
        },
        async ban(siteId, ipRef, until) {
            const key = `${siteId}:${ipRef}`;
            repo.bans.set(key, Math.max(repo.bans.get(key) ?? 0, until));
        },
        async pruneBans(now) {
            let gone = 0;
            for (const [key, until] of repo.bans) {
                if (until >= now) continue;
                repo.bans.delete(key);
                gone++;
            }
            return gone;
        },
        async insertSubmission(input) {
            const id = ++seq;
            repo.submissions.push({
                id,
                form_id: input.formId,
                site_id: input.siteId,
                ts: input.ts,
                ip_ref: input.ipRef,
                session_id: input.sessionId,
                content: input.content
            });
            return id;
        },
        async touchForm(formId, at) {
            const f = repo.forms.find((x) => x.id === formId);
            if (f) Object.assign(f, { submissions: f.submissions + 1, last_at: Math.max(f.last_at ?? 0, at) });
        },
        async bumpFormSubmissions(formId, delta) {
            const f = repo.forms.find((x) => x.id === formId);
            if (f) f.submissions = Math.max(0, f.submissions + delta);
        },
        async resolveFormLabel(formId, kind, labelRef, content) {
            const hit = repo.formLabels.find(
                (l) => l.form_id === formId && l.kind === kind && l.label_ref === labelRef
            );
            if (hit) return hit.id;
            const id = ++seq;
            repo.formLabels.push({ id, form_id: formId, kind, label_ref: labelRef, content });
            return id;
        },
        findFormLabel: async (formId, kind, labelRef) =>
            repo.formLabels.find((l) => l.form_id === formId && l.kind === kind && l.label_ref === labelRef)?.id ??
            null,
        countAnswerValues: async (formId, fieldId) =>
            [...repo.answers.keys()].filter((k) => k.startsWith(`${formId}:${fieldId}:`)).length,
        countAnswerFields: async (formId) =>
            repo.formLabels.filter((l) => l.form_id === formId && l.kind === 'field').length,
        async bumpAnswer(formId, fieldId, valueId, delta) {
            const key = `${formId}:${fieldId}:${valueId}`;
            repo.answers.set(key, Math.max(0, (repo.answers.get(key) ?? 0) + delta));
        },
        listSubmissions: unused,
        findSubmission: async (id) => repo.submissions.find((b) => b.id === id) ?? null,
        removeSubmission: unused,
        readAnswers: unused,
        feedbackStats: unused,
        dailyPoints: unused,
        async pruneOrphanLabels(siteId) {
            repo.pruned.labels.push(siteId);
            return 1;
        }
    };
    return repo;
}

async function unused(): Promise<never> {
    throw new Error('non attendu ici');
}

function request(over: Partial<IngestRequest> = {}): IngestRequest {
    return {
        key: KEY,
        origin: 'https://exemple.fr',
        ip: '203.0.113.7',
        userAgent: UA,
        events: [{ type: 'view', path: '/tarifs/' }],
        ...over
    };
}

/** L'identifiant du libellé d'une question, tel que le dépôt l'a rendu. */
function fieldIdOf(repo: FakeRepo, name: string): number {
    const label = repo.formLabels.find((l) => l.kind === 'field' && l.content === name);
    assert.ok(label, `question « ${name} » absente`);
    return label.id;
}

function submission(over: Partial<SubmitRequest> = {}): SubmitRequest {
    return {
        key: KEY,
        form: 'contact',
        fields: { satisfaction: 4, canaux: ['mail', 'sms'], message: 'x'.repeat(200) },
        path: '/contact',
        origin: 'https://exemple.fr',
        ip: '203.0.113.7',
        userAgent: UA,
        ...over
    };
}

/** Le service sur le harnais : les deux tickers, dans l'ordre où le service les pose. */
function ingestWith(repo: FakeRepo, quotaLimits?: Record<string, number>) {
    const deps = createTestServiceDeps({ repo, quotaLimits });
    const ingest = new AudienceIngest(deps);
    return {
        deps,
        ingest,
        flush: () => deps.recorded.tickers[0].tick(),
        maintain: () => deps.recorded.tickers[1].tick()
    };
}

describe('accepter puis vider', () => {
    it('pose deux tickers (une seconde, une heure), et un événement accepté entre en base à la vidange', async () => {
        const repo = fakeRepo([site()]);
        const { deps, ingest, flush } = ingestWith(repo);
        assert.deepEqual(
            deps.recorded.tickers.map((t) => t.intervalMs),
            [1_000, 3_600_000]
        );

        await ingest.accept(
            request({ events: [{ type: 'view', path: '/tarifs/?utm=x', referrer: 'https://google.fr/q' }] })
        );
        // Rien n'est écrit dans la requête.
        assert.equal(repo.events.length, 0);
        assert.equal(repo.sessions.length, 0);

        await flush();
        // Une session, avec ses dimensions posées à l'ouverture (chemin
        // d'entrée normalisé, référent réduit à l'hôte, navigateur lu du
        // user-agent), et un fait qui pointe le libellé du chemin.
        assert.equal(repo.sessions.length, 1);
        const session = repo.sessions[0];
        assert.equal(session.siteId, 1);
        assert.equal(session.touched, 1);
        const labelOf = (kind: string, value: string) => repo.labels.get(`1:${kind}:${value}`);
        assert.equal(session.entryPathId, labelOf('path', '/tarifs'));
        assert.equal(session.referrerId, labelOf('referrer', 'google.fr'));
        assert.equal(session.browserId, labelOf('browser', 'Firefox'));
        assert.equal(session.osId, labelOf('os', 'Linux'));
        assert.equal(session.deviceId, labelOf('device', 'desktop'));
        assert.deepEqual(
            repo.events.map((e) => [e.siteId, e.sessionId, e.kind, e.pathId, e.nameId]),
            [[1, session.id, 0, labelOf('path', '/tarifs'), null]]
        );
        assert.deepEqual(
            repo.touchedSites.map(([id]) => id),
            [1]
        );
        assert.deepEqual(deps.recorded.liveChanges, [1]);
    });

    it('une identité arrivée en cours de visite rattache la session déjà ouverte', async () => {
        const repo = fakeRepo([site()]);
        const { ingest, flush } = ingestWith(repo);
        await ingest.accept(request());
        await flush();
        await ingest.accept(
            request({ events: [{ type: 'event', path: '/compte', name: 'connexion', identity: 'alice' }] })
        );
        await flush();
        assert.equal(repo.sessions.length, 1);
        assert.equal(repo.sessions[0].identityId, repo.labels.get('1:identity:alice'));
        assert.deepEqual(
            repo.events.map((e) => [e.kind, e.nameId]),
            [
                [0, null],
                [1, repo.labels.get('1:event:connexion')]
            ]
        );
    });
});

describe('les refus', () => {
    it('une origine refusée, une clé inconnue, un robot : rien n’entre, rien ne part', async () => {
        const repo = fakeRepo([site()]);
        const { deps, ingest, flush } = ingestWith(repo);
        await ingest.accept(request({ origin: 'https://autre.fr' }));
        await ingest.accept(request({ origin: null }));
        await ingest.accept(request({ key: 'pk_000000000000000000000009' }));
        await ingest.accept(request({ userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1)' }));
        await ingest.accept(request({ events: [{ type: 'event', path: '/', name: '  ' }] }));
        await flush();
        assert.equal(repo.events.length, 0);
        assert.equal(repo.sessions.length, 0);
        assert.deepEqual(deps.recorded.liveChanges, []);
    });

    it('un site éteint n’accepte plus rien ; un site `app` accepte sans `Origin`', async () => {
        const repo = fakeRepo([
            site({ active: 0 }),
            site({ id: 2, public_key: 'pk_000000000000000000000002', platform: 'app' })
        ]);
        const { ingest, flush } = ingestWith(repo);
        await ingest.accept(request());
        await ingest.accept(request({ key: 'pk_000000000000000000000002', origin: null }));
        await flush();
        assert.deepEqual(
            repo.events.map((e) => e.siteId),
            [2]
        );
    });
});

describe('le direct, coalescé', () => {
    it('deux vidanges dans la même minute ne produisent qu’un battement par espace', async () => {
        const repo = fakeRepo([site(), site({ id: 2, workspace_id: 2, public_key: 'pk_000000000000000000000002' })]);
        const { deps, ingest, flush } = ingestWith(repo);
        await ingest.accept(request());
        await flush();
        await ingest.accept(request());
        await ingest.accept(request({ key: 'pk_000000000000000000000002' }));
        await flush();
        assert.equal(repo.events.length, 3);
        assert.deepEqual(deps.recorded.liveChanges, [1, 2]);
    });
});

describe('le cache des sites', () => {
    it('`invalidate` fait relire un site que le cache tenait pour actif', async () => {
        const repo = fakeRepo([site()]);
        const { ingest, flush } = ingestWith(repo);
        await ingest.accept(request());
        // Éteint en base : le cache, lui, ne le sait pas encore.
        repo.sites[0].active = 0;
        await ingest.accept(request());
        await flush();
        assert.equal(repo.events.length, 2);

        ingest.invalidate();
        await ingest.accept(request());
        await flush();
        assert.equal(repo.events.length, 2);
    });
});

describe('le ménage', () => {
    it('agrège hier et aujourd’hui, élague à la rétention du site, et balaie les libellés orphelins', async () => {
        const repo = fakeRepo([site({ retention_days: 30 })]);
        const { maintain } = ingestWith(repo);
        const before = Math.floor(Date.now() / 1000);
        await maintain();
        const after = Math.floor(Date.now() / 1000);

        assert.deepEqual(
            repo.rollups.map(([siteId, day, from, to]) => [siteId, day, to - from]),
            [
                [1, dayKey(before - 86400), 86400],
                [1, dayKey(before), 86400]
            ]
        );
        assert.equal(repo.pruned.events.length, 1);
        const [siteId, cutoff] = repo.pruned.events[0];
        assert.equal(siteId, 1);
        assert.ok(cutoff >= before - 30 * 86400 && cutoff <= after - 30 * 86400);
        assert.deepEqual(repo.pruned.sessions, [[1, cutoff]]);
        // Quelque chose a disparu : les libellés sont balayés.
        assert.deepEqual(repo.pruned.labels, [1]);
    });
});

describe('le sel des visiteurs', () => {
    it('est dérivé de la clé serveur par le SDK, une fois, et vaut d’une instance à l’autre', async () => {
        const repo = fakeRepo([site({ visitor_mode: 'persistent' })]);
        const deps = createTestServiceDeps({ repo });
        const asked: [string, string, number][] = [];
        const derive = deps.keys.derive;
        deps.keys = {
            ...deps.keys,
            derive: (salt, info, length) => {
                asked.push([salt, info, length]);
                return derive(salt, info, length);
            }
        };

        const first = new AudienceIngest(deps);
        assert.deepEqual(asked, [['audience', 'visitor-salt', 32]]);

        // Un visiteur persistant est reconnu à l'identique par un second
        // processus : le sel ne dépend que de la clé serveur.
        await first.accept(request({ visitorId: 'abc-123' }));
        await deps.recorded.tickers[0].tick();
        const second = new AudienceIngest(deps);
        await second.accept(request({ visitorId: 'abc-123', ip: '198.51.100.4' }));
        await deps.recorded.tickers[2].tick();
        assert.equal(repo.sessions.length, 1);
        assert.equal(repo.sessions[0].touched, 2);
        assert.equal(asked.length, 2);
    });
});

/** Un site qui laisse naître ses formulaires : ce n'est plus le défaut. */
function autoSite(over: Partial<AudienceSiteRow> = {}): AudienceSiteRow {
    return site({ forms_auto: 1, ...over });
}

/** Un formulaire déclaré, tel que l'écran de réglages l'aurait posé. */
function declared(fields: AudienceFormField[], over: Partial<AudienceFormRow> = {}): AudienceFormRow {
    return {
        id: 10,
        site_id: 1,
        name_ref: nameRef('contact'),
        mode: 'strict',
        form_schema: JSON.stringify({ fields }),
        is_open: 1,
        closed_at: null,
        closed_reason: null,
        submissions: 0,
        last_at: null,
        sort_order: 0,
        content: 'contact',
        created: 1,
        ...over
    };
}

function textField(name: string, over: Partial<AudienceFormField> = {}): AudienceFormField {
    return { name, kind: 'text', required: false, choices: [], multiple: false, ...over };
}

describe('AudienceIngest : les retours', () => {
    it('écrit avant de rendre la main, et compte les réponses', async () => {
        const repo = fakeRepo([autoSite()]);
        const { ingest } = ingestWith(repo);

        // Rien à vidanger : `submit` écrit avant de rendre la main, contrairement
        // à la mesure. C'est ce que ce test tient.
        assert.deepEqual(await ingest.submit(submission()), { status: 'stored' });

        assert.equal(repo.forms.length, 1);
        assert.equal(repo.forms[0].submissions, 1);
        assert.deepEqual(JSON.parse(repo.submissions[0].content), {
            fields: { satisfaction: 4, canaux: ['mail', 'sms'], message: 'x'.repeat(200) },
            path: '/contact'
        });

        // Trois questions, dont une à choix multiples qui compte ses deux valeurs.
        const fields = repo.formLabels.filter((l) => l.kind === 'field').map((l) => l.content);
        assert.deepEqual(fields.sort(), ['canaux', 'message', 'satisfaction']);
        // Un message est un texte, pas un choix : aucun libellé de valeur, il tombe
        // au seau. « 4 » (un nombre rendu canoniquement) et les deux canaux, si.
        const values = repo.formLabels.filter((l) => l.kind === 'value').map((l) => l.content);
        assert.deepEqual(values.sort(), ['4', 'mail', 'sms']);
        assert.equal(repo.answers.get(`1:${fieldIdOf(repo, 'message')}:0`), 1, 'le seau « texte libre »');
        assert.equal(
            [...repo.answers.values()].reduce((a, b) => a + b, 0),
            4
        );
    });

    it('ne crée aucun formulaire tant que le site ne l’autorise pas', async () => {
        // Le défaut, et la correction qui compte : sans ce réglage, qui lit la clé
        // publique dans la page décidait des colonnes qu'on affiche.
        const repo = fakeRepo([site()]);
        const { ingest } = ingestWith(repo);

        assert.deepEqual(await ingest.submit(submission()), { status: 'ignored' });
        assert.equal(repo.forms.length, 0);
        assert.equal(repo.submissions.length, 0);
    });

    it('relie le retour à la visite ouverte du même visiteur, sans en ouvrir une', async () => {
        const repo = fakeRepo([autoSite()]);
        const { ingest, flush } = ingestWith(repo);
        await ingest.accept(request());
        await flush();

        await ingest.submit(submission());

        assert.equal(repo.sessions.length, 1, 'aucune visite ouverte par un retour');
        assert.equal(repo.submissions[0].session_id, repo.sessions[0].id);
    });

    it('refuse un formulaire fermé, et le rouvre dès que le cache est vidé', async () => {
        const repo = fakeRepo([autoSite()]);
        const { ingest } = ingestWith(repo);
        await ingest.submit(submission());

        repo.forms[0].is_open = 0;
        // Sans l'invalidation, la fermeture ne prendrait effet qu'au redémarrage :
        // c'est exactement ce que les handlers appellent après une mutation.
        ingest.invalidate();
        assert.deepEqual(await ingest.submit(submission()), { status: 'ignored' });
        assert.equal(repo.submissions.length, 1);

        repo.forms[0].is_open = 1;
        ingest.invalidate();
        await ingest.submit(submission());
        assert.equal(repo.submissions.length, 2);
    });

    it('cesse de créer des formulaires au-delà du plafond du site', async () => {
        const repo = fakeRepo([autoSite()]);
        const { ingest } = ingestWith(repo);
        for (let i = 0; i < AUDIENCE_MAX_FORMS + 5; i++) {
            await ingest.submit(submission({ form: `canal-${i}`, fields: { a: '1' } }));
        }
        assert.equal(repo.forms.length, AUDIENCE_MAX_FORMS);
        assert.equal(repo.submissions.length, AUDIENCE_MAX_FORMS);
    });

    it("décompte exactement ce qu'un retour avait compté", async () => {
        const repo = fakeRepo([autoSite()]);
        const { ingest, deps } = ingestWith(repo);
        await ingest.submit(submission({ fields: { recommande: 'oui' } }));
        await ingest.submit(submission({ fields: { recommande: 'non' } }));

        await countAnswers(repo, deps.cipherFor(1), repo.forms[0].id, { recommande: 'oui' }, -1);

        // Un seul des deux comptes bouge, et aucun ne passe sous zéro.
        assert.deepEqual([...repo.answers.values()].sort(), [0, 1]);
    });
});

describe('AudienceIngest : le mode strict', () => {
    const CONTACT = [textField('email', { kind: 'email', required: true }), textField('message')];

    it('convertit ce qui colle au schéma, et range la valeur convertie', async () => {
        const repo = fakeRepo([site()]);
        repo.forms.push(declared([textField('note', { kind: 'number' })]));
        const { ingest } = ingestWith(repo);

        // Un `<form>` HTML n'envoie que des chaînes : c'est le type déclaré qui
        // ramène « 4 » au nombre 4, et donc ce qui est rangé et compté.
        assert.deepEqual(await ingest.submit(submission({ fields: { note: '4' } })), { status: 'stored' });
        assert.deepEqual(JSON.parse(repo.submissions[0].content).fields, { note: 4 });
    });

    it('nomme le champ fautif plutôt que de se taire', async () => {
        const repo = fakeRepo([site()]);
        repo.forms.push(declared(CONTACT));
        const { ingest } = ingestWith(repo);

        // Le seul refus qui parle : il faut déjà une clé valide pour l'obtenir, et
        // sans lui un site qui vient de renommer un champ ne verrait rien.
        assert.deepEqual(await ingest.submit(submission({ fields: { email: 'a@b.fr', surprise: 'x' } })), {
            status: 'invalid',
            field: 'surprise',
            reason: 'unknown'
        });
        assert.deepEqual(await ingest.submit(submission({ fields: { message: 'bonjour' } })), {
            status: 'invalid',
            field: 'email',
            reason: 'missing'
        });
        assert.equal(repo.submissions.length, 0);
    });

    it('refuse tout quand le schéma est illisible', async () => {
        // Le doute profite à la fermeture : un blob abîmé ne doit pas faire passer
        // un formulaire strict pour permissif.
        const repo = fakeRepo([site()]);
        repo.forms.push(declared([], { form_schema: 'illisible' }));
        const { ingest } = ingestWith(repo);

        const res = await ingest.submit(submission({ fields: { email: 'a@b.fr' } }));
        assert.equal(res.status, 'invalid');
    });
});

describe('AudienceIngest : les quotas de retours', () => {
    it('arrête une adresse au-delà de son quota horaire', async () => {
        const repo = fakeRepo([autoSite({ submission_ip_quota: 2 })]);
        const { ingest } = ingestWith(repo);

        for (let i = 0; i < 5; i++) await ingest.submit(submission({ fields: { a: String(i) } }));

        assert.equal(repo.submissions.length, 2);
        // Refusé, pas fermé : c'est une provenance qui insiste, pas le formulaire
        // qui est submergé.
        assert.equal(repo.forms[0].is_open, 1);
    });

    it('écarte la provenance qui inonde, et laisse le formulaire ouvert aux autres', async () => {
        // La clé publique est dans la page du site : fermer le canal faisait payer
        // au site ce qu'un tiers lui faisait, et pour des jours.
        const repo = fakeRepo([autoSite({ submission_ip_quota: 0, submission_ban_quota: 3 })]);
        const { ingest } = ingestWith(repo);

        for (let i = 0; i < 6; i++) await ingest.submit(submission({ ip: '203.0.113.9' }));
        assert.equal(repo.submissions.length, 3, 'les trois du seuil, puis plus rien de cette adresse');
        assert.equal(repo.bans.size, 1);

        // Le formulaire n'a pas bougé, et le voisin passe.
        assert.equal(repo.forms[0].is_open, 1);
        assert.equal(repo.forms[0].closed_reason, null);
        await ingest.submit(submission({ ip: '198.51.100.4' }));
        assert.equal(repo.submissions.length, 4);
    });

    it('ne ferme plus rien sur un afflux distribué : chaque adresse reste sous le seuil', async () => {
        // C'est le prix assumé du choix : un flot réparti sur mille adresses passe
        // sous une garde qui ne vise que la provenance.
        const repo = fakeRepo([autoSite({ submission_ip_quota: 0, submission_ban_quota: 3, form_hourly_quota: 3 })]);
        const { ingest } = ingestWith(repo);

        for (let i = 0; i < 6; i++) await ingest.submit(submission({ ip: `203.0.113.${i}` }));
        assert.equal(repo.submissions.length, 6);
        assert.equal(repo.bans.size, 0);
        assert.equal(repo.forms[0].is_open, 1);
    });

    it('n’écarte personne quand le seuil est à zéro', async () => {
        const repo = fakeRepo([autoSite({ submission_ip_quota: 0, submission_ban_quota: 0 })]);
        const { ingest } = ingestWith(repo);
        for (let i = 0; i < 5; i++) await ingest.submit(submission({ fields: { a: String(i) } }));
        assert.equal(repo.submissions.length, 5);
        assert.equal(repo.bans.size, 0);
    });

    it('ne compte rien quand le quota est à zéro', async () => {
        const repo = fakeRepo([autoSite({ submission_ip_quota: 0, form_hourly_quota: 0 })]);
        const { ingest } = ingestWith(repo);
        for (let i = 0; i < 5; i++) await ingest.submit(submission({ fields: { a: String(i) } }));
        assert.equal(repo.submissions.length, 5);
    });
});

describe('AudienceIngest : le quota d’événements', () => {
    it('laisse tout passer tant qu’il est à zéro, et coupe au-delà', async () => {
        // Éteint par défaut : c'est ce qui empêche un site déjà branché de se
        // mettre à perdre des vues sans qu'on l'ait demandé.
        const libre = fakeRepo([site()]);
        const a = ingestWith(libre);
        for (let i = 0; i < 10; i++) await a.ingest.accept(request());
        await a.flush();
        assert.equal(libre.events.length, 10);

        const borne = fakeRepo([site({ event_ip_quota: 3 })]);
        const b = ingestWith(borne);
        for (let i = 0; i < 10; i++) await b.ingest.accept(request({ events: [{ type: 'view', path: `/p${i}` }] }));
        await b.flush();
        assert.equal(borne.events.length, 3);
    });

    it('compte par adresse et par site, pas globalement', async () => {
        const repo = fakeRepo([site({ event_ip_quota: 2 })]);
        const { ingest, flush } = ingestWith(repo);
        for (const ip of ['203.0.113.1', '203.0.113.2']) {
            for (let i = 0; i < 4; i++) {
                await ingest.accept(request({ ip, events: [{ type: 'view', path: `/p${i}` }] }));
            }
        }
        await flush();
        assert.equal(repo.events.length, 4, 'deux par adresse');
    });

    it('compte par événement et non par requête : un lot ne l’enjambe pas', async () => {
        // Compté par requête, un plafond de 2 laissait passer un lot entier, soit
        // AUDIENCE_BATCH_MAX fois trop.
        const repo = fakeRepo([site({ event_ip_quota: 2 })]);
        const { ingest, flush } = ingestWith(repo);
        await ingest.accept(
            request({
                events: [
                    { type: 'view', path: '/a' },
                    { type: 'view', path: '/b' },
                    { type: 'view', path: '/c' },
                    { type: 'view', path: '/d' }
                ]
            })
        );
        await flush();
        assert.equal(repo.events.length, 2);
    });
});

describe('AudienceIngest : les vues de l’offre du compte', () => {
    const view = (path: string) => request({ events: [{ type: 'view', path }] });

    it('n’écrit rien quand l’offre n’en inclut aucune, dès la première', async () => {
        const repo = fakeRepo([site()]);
        const { ingest, flush } = ingestWith(repo, { events: 0 });
        await ingest.accept(request());
        await flush();
        assert.equal(repo.events.length, 0);
    });

    it('s’arrête à la limite sans relire la base : elle compte ce qu’elle accepte', async () => {
        const repo = fakeRepo([site()]);
        let reads = 0;
        repo.monthlyEvents = async () => (reads++, 8);
        const { ingest, flush } = ingestWith(repo, { events: 10 });
        for (let i = 0; i < 6; i++) await ingest.accept(view(`/p${i}`));
        await flush();
        assert.equal(repo.events.length, 2, 'la neuvième et la dixième');
        assert.equal(reads, 1);
    });

    it('ne lit la base qu’une fois quand les vues arrivent ensemble', async () => {
        const repo = fakeRepo([site()]);
        let reads = 0;
        repo.monthlyEvents = async () => {
            reads++;
            await new Promise((resolve) => setImmediate(resolve));
            return 0;
        };
        const { ingest, flush } = ingestWith(repo, { events: 10 });
        await Promise.all(Array.from({ length: 5 }, (_, i) => ingest.accept(view(`/p${i}`))));
        await flush();
        assert.equal(reads, 1);
        assert.equal(repo.events.length, 5);
    });

    it('prévient les écrans une fois la limite atteinte, après avoir écrit les dernières vues', async () => {
        const repo = fakeRepo([site()]);
        repo.monthlyEvents = async () => 9;
        const { deps, ingest, flush } = ingestWith(repo, { events: 10 });
        await ingest.accept(view('/derniere'));
        await ingest.accept(view('/refusee'));
        assert.deepEqual(deps.recorded.liveChanges, [], 'rien tant que la dernière vue n’est pas en base');
        await flush();
        assert.equal(repo.events.length, 1);
        // La vidange prévient pour la vue écrite, puis pour l'état qui change.
        assert.deepEqual(deps.recorded.liveChanges, [1, 1]);
        await ingest.accept(view('/encore'));
        await flush();
        assert.deepEqual(deps.recorded.liveChanges, [1, 1], 'une seule annonce par limite atteinte');
    });

    it('coupe un lot au milieu plutôt que d’enjamber la limite', async () => {
        const repo = fakeRepo([site()]);
        repo.monthlyEvents = async () => 9;
        const { ingest, flush } = ingestWith(repo, { events: 10 });
        await ingest.accept(
            request({
                events: [
                    { type: 'view', path: '/a' },
                    { type: 'view', path: '/b' },
                    { type: 'view', path: '/c' }
                ]
            })
        );
        await flush();
        assert.equal(repo.events.length, 1);
    });

    it('tient le compte du mois sur l’espace, que la suppression d’un site ne touche pas', async () => {
        // Lu sur les sites, il tombait avec eux : supprimer puis recréer son site
        // remettait la consommation du mois à zéro.
        const repo = fakeRepo([site()]);
        const { ingest, flush } = ingestWith(repo, { events: 10 });
        await ingest.accept(
            request({
                events: [
                    { type: 'view', path: '/a' },
                    { type: 'view', path: '/b' }
                ]
            })
        );
        await flush();

        const month = monthKey(Math.floor(Date.now() / 1000));
        assert.deepEqual([...repo.usage], [[`1:${month}`, 2]]);
        assert.equal(await repo.monthlyEvents([1], month), 2);

        // Le site s'en va, le compte reste.
        repo.sites.length = 0;
        assert.equal(await repo.monthlyEvents([1], month), 2);
    });
});

/** Le contrat offert à Projets, tel que `createService` le publie au boot. */
function itemsProviderOn(repo: FakeRepo): AudienceItemsProvider {
    const service = serverEntry.createService?.(createTestServiceDeps({ repo }));
    assert.ok(service, 'le module crée un service');
    const provider = service.providers?.[AUDIENCE_ITEMS_PROVIDER] as AudienceItemsProvider | undefined;
    assert.ok(provider, 'le service publie le contrat des éléments');
    return provider;
}

describe('AUDIENCE_ITEMS_PROVIDER : labelOf', () => {
    it("rend le nom déchiffré d'un site vivant, null pour un identifiant inconnu ou un autre espace", async () => {
        const provider = itemsProviderOn(fakeRepo([site()]));
        assert.equal(await provider.labelOf(1, 1), 'Vitrine');
        assert.equal(await provider.labelOf(42, 1), null);
        assert.equal(await provider.labelOf(1, 2), null);
    });
});
