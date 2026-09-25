import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { z, ZodType } from 'zod';

import {
    audienceFormClear,
    audienceFormList,
    audienceFormRemove,
    audienceFormUpdate,
    audienceResults,
    audienceSubmissionList,
    audienceSubmissionRemove
} from '../contracts/commands';
import type {
    AudienceFormLabelRow,
    AudienceFormRow,
    AudienceSiteRow,
    AudienceSubmissionRow
} from '../contracts/domain';
import { FeatureError, type SdkFeatureContext } from '@deveye/types/sdk/server';
import { createTestContext } from '@deveye/types/sdk/testing';

import { audienceHandlers } from './handlers';
import { manifest } from '../manifest';
import { labelRef } from './normalize';
import type { AudienceRepo } from './repo';
import type { AudienceSubmissionWithContextRow } from './repoForms';
import type { AudienceIngest } from './service';
import { setIngest } from './_shared';

/**
 * Les commandes des retours, sur le harnais du SDK. On tient ce qui ne lève
 * nulle part quand ça se dérègle : la frontière d'espace (un formulaire n'est
 * pas un élément partageable, c'est son site qui l'est), la pagination par
 * curseur, le regroupement d'une répartition, le cache de l'ingestion vidé par
 * chaque mutation, et surtout la décrémentation exacte à la suppression d'un
 * retour, sans quoi la vue Résultats compterait indéfiniment des réponses
 * effacées.
 */

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
    forms: AudienceFormRow[];
    submissions: AudienceSubmissionRow[];
    formLabels: AudienceFormLabelRow[];
    answers: Map<string, number>;
}

function site(id: number, workspaceId: number): AudienceSiteRow {
    return {
        id,
        workspace_id: workspaceId,
        public_key: `pk_${String(id).padStart(24, '0')}`,
        name_ref: `ref-${id}`,
        platform: 'web',
        visitor_mode: 'anonymous',
        origins: 'exemple.fr',
        active: 1,
        retention_days: 180,
        forms_auto: 0,
        submission_ip_quota: 5,
        submission_ban_quota: 60,
        form_hourly_quota: 200,
        event_ip_quota: 0,
        sort_order: id,
        last_event_at: null,
        content: JSON.stringify({ name: `Site ${id}`, description: '' }),
        created: 1
    };
}

/**
 * Un dépôt en mémoire, même contrat que le vrai. `projections` reproduit
 * `item_shares` : un site projeté se lit ici mais ne s'y règle pas.
 */
function fakeRepo(projections: Record<number, number[]> = {}): FakeRepo {
    let seq = 100;
    const unused = async () => {
        throw new Error('non attendu ici');
    };
    const repo: FakeRepo = {
        sites: [],
        forms: [],
        submissions: [],
        formLabels: [],
        answers: new Map(),
        monthlyEvents: async (ids: readonly number[]) => ids.length - ids.length,
        countSiteSubmissionsSince: unused,
        banUntil: unused,
        ban: unused,
        pruneBans: unused,
        bumpUsage: async () => undefined,
        countInWorkspaces: async (ids: readonly number[]) => ids.length - ids.length,
        listStock: unused,
        list: unused,
        listVisible: unused,
        find: async (id, workspaceId) => repo.sites.find((s) => s.id === id && s.workspace_id === workspaceId) ?? null,
        findVisible: async (id, workspaceId) =>
            repo.sites.find(
                (s) =>
                    s.id === id && (s.workspace_id === workspaceId || (projections[s.id] ?? []).includes(workspaceId))
            ) ?? null,
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

        listForms: async (siteId) => repo.forms.filter((f) => f.site_id === siteId),
        findForm: async (formId) => repo.forms.find((f) => f.id === formId) ?? null,
        findFormByName: async (siteId, nameRef) =>
            repo.forms.find((f) => f.site_id === siteId && f.name_ref === nameRef) ?? null,
        countForms: async (siteId) => repo.forms.filter((f) => f.site_id === siteId).length,
        async updateForm(input) {
            const f = repo.forms.find((x) => x.id === input.formId);
            if (!f) return;
            Object.assign(f, {
                name_ref: input.nameRef,
                content: input.content,
                mode: input.mode,
                form_schema: input.formSchema,
                is_open: input.open ? 1 : 0
            });
            if (input.open) Object.assign(f, { closed_at: null, closed_reason: null });
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
            for (const key of [...repo.answers.keys()]) if (key.startsWith(`${formId}:`)) repo.answers.delete(key);
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
        insertSubmission: unused,
        countSubmissionsSince: unused,
        touchForm: unused,
        async bumpFormSubmissions(formId, delta) {
            const f = repo.forms.find((x) => x.id === formId);
            if (f) f.submissions = Math.max(0, f.submissions + delta);
        },
        async resolveFormLabel(formId, kind, ref, content) {
            const hit = repo.formLabels.find((l) => l.form_id === formId && l.kind === kind && l.label_ref === ref);
            if (hit) return hit.id;
            const id = ++seq;
            repo.formLabels.push({ id, form_id: formId, kind, label_ref: ref, content });
            return id;
        },
        findFormLabel: async (formId, kind, ref) =>
            repo.formLabels.find((l) => l.form_id === formId && l.kind === kind && l.label_ref === ref)?.id ?? null,
        countAnswerValues: async (formId, fieldId) =>
            [...repo.answers.keys()].filter((k) => k.startsWith(`${formId}:${fieldId}:`)).length,
        countAnswerFields: async (formId) =>
            repo.formLabels.filter((l) => l.form_id === formId && l.kind === 'field').length,
        async bumpAnswer(formId, fieldId, valueId, delta) {
            const key = `${formId}:${fieldId}:${valueId}`;
            repo.answers.set(key, Math.max(0, (repo.answers.get(key) ?? 0) + delta));
        },
        async listSubmissions({ formId, order, cursorTs, cursorId, limit }) {
            const desc = order === 'recent';
            const sorted = repo.submissions
                .filter((b) => b.form_id === formId)
                .sort((a, b) => (desc ? b.ts - a.ts || b.id - a.id : a.ts - b.ts || a.id - b.id));
            const after =
                cursorTs === null || cursorId === null
                    ? sorted
                    : sorted.filter((b) =>
                          desc
                              ? b.ts < cursorTs || (b.ts === cursorTs && b.id < cursorId)
                              : b.ts > cursorTs || (b.ts === cursorTs && b.id > cursorId)
                      );
            return after.slice(0, limit).map((b): AudienceSubmissionWithContextRow => ({
                ...b,
                entry_path_content: b.session_id === null ? null : '/accueil',
                referrer_content: b.session_id === null ? null : 'google.com',
                browser_content: b.session_id === null ? null : 'Firefox',
                device_content: b.session_id === null ? null : 'desktop'
            }));
        },
        findSubmission: async (id) => repo.submissions.find((b) => b.id === id) ?? null,
        async removeSubmission(id) {
            const i = repo.submissions.findIndex((b) => b.id === id);
            if (i === -1) return false;
            repo.submissions.splice(i, 1);
            return true;
        },
        async readAnswers(formId) {
            const label = (id: number) => repo.formLabels.find((l) => l.id === id);
            return [...repo.answers.entries()]
                .map(([key, count]) => {
                    const [form, field, value] = key.split(':').map(Number);
                    return { form, field_id: field, value_id: value, hits: count };
                })
                .filter((row) => row.form === formId && row.hits > 0)
                .sort((a, b) => a.field_id - b.field_id || b.hits - a.hits || a.value_id - b.value_id)
                .map((row) => ({
                    field_id: row.field_id,
                    field_content: label(row.field_id)?.content ?? '',
                    value_id: row.value_id,
                    value_content: row.value_id === 0 ? null : (label(row.value_id)?.content ?? null),
                    hits: row.hits
                }));
        },
        feedbackStats: unused,
        dailyPoints: unused
    };
    return repo;
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

/** Un formulaire garni : deux retours, et les compteurs qu'ils auraient posés. */
async function seeded(projections: Record<number, number[]> = {}): Promise<FakeRepo> {
    const repo = fakeRepo(projections);
    repo.sites.push(site(1, 1), site(7, 42));
    repo.forms.push({
        id: 10,
        site_id: 1,
        name_ref: 'ref-contact',
        mode: 'auto',
        form_schema: null,
        is_open: 1,
        closed_at: null,
        closed_reason: null,
        submissions: 2,
        last_at: 2000,
        sort_order: 0,
        content: 'contact',
        created: 1
    });
    repo.submissions.push(
        {
            id: 1,
            form_id: 10,
            site_id: 1,
            ts: 1000,
            ip_ref: '',
            session_id: null,
            content: seal({ recommande: 'oui' }, '/a')
        },
        {
            id: 2,
            form_id: 10,
            site_id: 1,
            ts: 2000,
            ip_ref: '',
            session_id: 5,
            content: seal({ recommande: 'non' }, '/b')
        }
    );
    const field = await repo.resolveFormLabel(10, 'field', labelRef('recommande'), 'recommande');
    const oui = await repo.resolveFormLabel(10, 'value', labelRef('oui'), 'oui');
    const non = await repo.resolveFormLabel(10, 'value', labelRef('non'), 'non');
    await repo.bumpAnswer(10, field, oui, 1);
    await repo.bumpAnswer(10, field, non, 1);
    return repo;
}

/** Le harnais chiffre à l'identité : « scellé » est ici du JSON lisible. */
function seal(fields: Record<string, unknown>, path: string): string {
    return JSON.stringify({ fields, path });
}

describe('audience.formList', () => {
    it('rend les formulaires du site, déchiffrés, y compris depuis une projection', async () => {
        const repo = await seeded({ 1: [2] });
        const ctx = createTestContext({ repo, workspaceId: 2, shares: { 1: 1 } });
        const { forms } = await handlerFor(audienceFormList)(ctx, { siteId: 1 });
        assert.deepEqual(
            forms.map((f) => [f.id, f.name, f.open, f.submissions]),
            [[10, 'contact', true, 2]]
        );
    });

    it('refuse un site qu’on ne voit pas', async () => {
        const repo = await seeded();
        const ctx = createTestContext({ repo, workspaceId: 1 });
        await assert.rejects(() => handlerFor(audienceFormList)(ctx, { siteId: 7 }), failsWith('not_found'));
    });
});

describe('audience.formUpdate', () => {
    it('renomme, referme, et fait oublier son cache à l’ingestion', async () => {
        const repo = await seeded();
        const ingest = mountIngest();
        const ctx = createTestContext({ repo, workspaceId: 1 });

        const { form } = await handlerFor(audienceFormUpdate)(ctx, {
            formId: 10,
            name: 'Sondage',
            mode: 'auto',
            fields: [],
            open: false
        });
        assert.equal(form.name, 'Sondage');
        assert.equal(form.open, false);
        // Sans cet oubli, la fermeture ne prendrait effet qu'au redémarrage.
        assert.equal(ingest.invalidated, 1);
    });

    it('refuse depuis une projection : un formulaire se règle chez lui', async () => {
        const repo = await seeded({ 1: [2] });
        const ctx = createTestContext({ repo, workspaceId: 2, shares: { 1: 1 } });
        await assert.rejects(
            () =>
                handlerFor(audienceFormUpdate)(ctx, {
                    formId: 10,
                    name: 'Sondage',
                    mode: 'auto',
                    fields: [],
                    open: true
                }),
            failsWith('forbidden')
        );
    });
});

describe('audience.submissionList', () => {
    it('pagine par curseur et rend le contexte de la visite quand il existe', async () => {
        const repo = await seeded();
        const ctx = createTestContext({ repo, workspaceId: 1 });

        const first = await handlerFor(audienceSubmissionList)(ctx, { formId: 10, order: 'recent', limit: 1 });
        assert.deepEqual(
            first.submissions.map((b) => [b.id, b.fields, b.path]),
            [[2, { recommande: 'non' }, '/b']]
        );
        assert.deepEqual(first.submissions[0].context, {
            entryPath: '/accueil',
            referrer: 'google.com',
            browser: 'Firefox',
            device: 'desktop'
        });
        assert.equal(first.nextCursor, '2000:2');

        const next = await handlerFor(audienceSubmissionList)(ctx, {
            formId: 10,
            order: 'recent',
            limit: 1,
            cursor: first.nextCursor
        });
        assert.deepEqual(
            next.submissions.map((b) => b.id),
            [1]
        );
        // Plus rien après : le curseur s'arrête, il ne boucle pas.
        assert.equal(next.nextCursor, null);
        // Un envoi hors visite n'invente pas de contexte.
        assert.equal(next.submissions[0].context, null);
    });
});

describe('audience.results', () => {
    it('regroupe par question, sépare le seau du texte libre', async () => {
        const repo = await seeded();
        // Une seconde question, entièrement en texte libre.
        const message = await repo.resolveFormLabel(10, 'field', labelRef('message'), 'message');
        await repo.bumpAnswer(10, message, 0, 2);
        const ctx = createTestContext({ repo, workspaceId: 1 });

        const results = await handlerFor(audienceResults)(ctx, { formId: 10 });
        assert.equal(results.total, 2);
        assert.deepEqual(results.fields, [
            {
                name: 'recommande',
                // `null` : ce formulaire est en mode auto, la question a été
                // découverte et non déclarée.
                kind: null,
                answered: 2,
                free: 0,
                values: [
                    { label: 'oui', count: 1 },
                    { label: 'non', count: 1 }
                ]
            },
            { name: 'message', kind: null, answered: 2, free: 2, values: [] }
        ]);
    });
});

describe('audience.submissionRemove', () => {
    it('défait exactement ce que le retour avait compté', async () => {
        const repo = await seeded();
        mountIngest();
        const ctx = createTestContext({ repo, workspaceId: 1 });

        await handlerFor(audienceSubmissionRemove)(ctx, { submissionId: 1 });

        assert.equal(repo.submissions.length, 1);
        assert.equal(repo.forms[0].submissions, 1);
        const results = await handlerFor(audienceResults)(ctx, { formId: 10 });
        // « oui » tombe à zéro et disparaît du classement, « non » ne bouge pas.
        assert.deepEqual(results.fields[0].values, [{ label: 'non', count: 1 }]);
    });

    it('ne décompte qu’une fois ce qu’il n’a supprimé qu’une fois', async () => {
        // Deux appels concurrents lisent la ligne avant qu'aucun ne l'efface : le
        // premier supprime, le second ne retire rien. Sans le verdict de la
        // suppression, les deux décrémentaient, et plus rien ne le rattrapait,
        // la charge utile étant chiffrée. On fige ici la lecture pour que les
        // deux voient la ligne, ce que la course produit d'elle-même.
        const repo = await seeded();
        mountIngest();
        const ctx = createTestContext({ repo, workspaceId: 1 });
        const seen = repo.submissions[0];
        repo.findSubmission = async () => seen;

        await handlerFor(audienceSubmissionRemove)(ctx, { submissionId: 1 });
        await handlerFor(audienceSubmissionRemove)(ctx, { submissionId: 1 });

        assert.equal(repo.forms[0].submissions, 1);
        const results = await handlerFor(audienceResults)(ctx, { formId: 10 });
        assert.deepEqual(results.fields[0].values, [{ label: 'non', count: 1 }]);
    });

    it('refuse un retour d’un autre espace', async () => {
        const repo = await seeded();
        const ctx = createTestContext({ repo, workspaceId: 2 });
        await assert.rejects(
            () => handlerFor(audienceSubmissionRemove)(ctx, { submissionId: 1 }),
            failsWith('not_found')
        );
    });
});

describe('audience.formClear et audience.formRemove', () => {
    it('vident les compteurs en bloc plutôt que ligne à ligne', async () => {
        const repo = await seeded();
        mountIngest();
        const ctx = createTestContext({ repo, workspaceId: 1 });

        assert.deepEqual(await handlerFor(audienceFormClear)(ctx, { formId: 10 }), { removed: 2 });
        assert.equal(repo.submissions.length, 0);
        assert.equal(repo.answers.size, 0);
        // Le canal reste : c'est ce qui distingue vider de supprimer.
        assert.equal(repo.forms.length, 1);
        assert.equal(repo.forms[0].submissions, 0);

        await handlerFor(audienceFormRemove)(ctx, { formId: 10 });
        assert.equal(repo.forms.length, 0);
    });
});

/**
 * Ce que les visiteurs écrivent est la seule donnée nominative du module. Deux
 * droits de rôle l'ouvrent, et `absent = refusé` est le contrat du SDK : un
 * oubli de déclaration n'échoue nulle part, il ouvre simplement la porte.
 */
describe('les droits sur les retours', () => {
    it('les déclare dans le manifest, tous deux en interrupteur', () => {
        assert.deepEqual(
            (manifest.extraPermissions ?? []).map((extra) => [extra.key, extra.type]),
            [
                ['submissions', 'toggle'],
                ['submissionsExport', 'toggle']
            ]
        );
    });

    it('ferme les trois commandes qui rendent des messages, et elles seules', () => {
        const gated = audienceHandlers
            .filter((def) => (def.access?.extras ?? []).includes('submissions'))
            .map((def) => def.command)
            .sort();
        assert.deepEqual(gated, ['audience.results', 'audience.submissionList', 'audience.submissionRemove']);
    });
});
