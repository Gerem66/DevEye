import {
    audienceFormAdd,
    audienceFormClear,
    audienceFormList,
    audienceFormRemove,
    audienceFormUpdate,
    audienceResults,
    audienceSubmissionList,
    audienceSubmissionRemove
} from '../contracts/commands';
import {
    AUDIENCE_MAX_FORMS,
    AUDIENCE_SUBMISSION_PAGE,
    type AudienceFieldValue,
    type AudienceForm,
    type AudienceFormClosure,
    type AudienceFormField,
    type AudienceFormRow,
    type AudienceResultField,
    type AudienceSubmission
} from '../contracts/domain';
import { defineSdkFeature, FeatureError, type SdkCipher } from '@deveye/types/sdk/server';

import { countAnswers } from './answers';
import { ingestOf, loadHomeSite, loadSite, nameRef, readJson, readLabel, siteCipher, type Ctx } from './_shared';
import type { AudienceSubmissionWithContextRow } from './repoForms';

/**
 * Les retours d'un site : les canaux qui les reçoivent, ce qu'ils ont reçu, et
 * la répartition des réponses.
 *
 * Un formulaire se **déclare** ici, avec ses champs et leur type : le laisser
 * naître d'une réception, comme la première version le faisait, donnait à qui
 * lit la clé publique dans la page le pouvoir de décider des colonnes qu'on
 * affiche. Le mode `auto` d'un formulaire et l'interrupteur `formsAuto` du site
 * rouvrent cette porte, pour qui la veut, tous deux éteints par défaut.
 *
 * Toute écriture appelle `ingestOf()?.invalidate()` : le service tient un cache
 * `site:nom → formulaire`, et sans cet appel un formulaire fermé continuerait
 * d'accepter pendant toute la vie du processus.
 */

/** Ce que porte `ft_audience_submissions.content`, chiffré. */
interface StoredSubmission {
    fields: Record<string, AudienceFieldValue>;
    path?: string;
}

/** Ce que porte `ft_audience_forms.form_schema`, chiffré. */
interface StoredSchema {
    fields: readonly AudienceFormField[];
}

async function toForm(cipher: SdkCipher, row: AudienceFormRow): Promise<AudienceForm> {
    const stored = await readJson<Partial<StoredSchema>>(cipher, row.form_schema);
    return {
        id: Number(row.id),
        name: (await readLabel(cipher, row.content)) || 'Sans nom',
        mode: row.mode === 'strict' ? 'strict' : 'auto',
        fields: [...(stored?.fields ?? [])],
        open: Number(row.is_open) === 1,
        closedAt: row.closed_at === null ? null : Number(row.closed_at),
        closedReason: (row.closed_reason as AudienceFormClosure | null) ?? null,
        submissions: Number(row.submissions),
        lastAt: row.last_at === null ? null : Number(row.last_at),
        created: Number(row.created)
    };
}

/**
 * Le schéma scellé, ou `null` en mode auto. Un formulaire auto qui garderait
 * ses champs les rejouerait en repassant en strict, ce qui ferait ressusciter
 * une déclaration qu'on croyait avoir retirée.
 */
async function sealSchema(
    cipher: SdkCipher,
    mode: string,
    fields: readonly AudienceFormField[]
): Promise<string | null> {
    if (mode !== 'strict') return null;
    return cipher.encrypt(JSON.stringify({ fields } satisfies StoredSchema));
}

/**
 * Le formulaire, une fois son site vérifié. C'est le site qui porte la
 * frontière d'espace et la restriction de rôle : le formulaire n'est pas un
 * élément partageable, il pend au site qui l'est.
 */
async function loadForm(ctx: Ctx, formId: number): Promise<AudienceFormRow> {
    const row = await ctx.repo.findForm(formId);
    if (!row) throw new FeatureError('not_found', 'Formulaire introuvable');
    await loadSite(ctx, Number(row.site_id));
    return row;
}

/** Comme {@link loadForm}, mais pour les gestes réservés au domicile du site. */
async function loadHomeForm(ctx: Ctx, formId: number): Promise<AudienceFormRow> {
    const row = await loadForm(ctx, formId);
    await loadHomeSite(ctx, Number(row.site_id));
    return row;
}

export const audienceFormListFeature = defineSdkFeature({
    ...audienceFormList,
    handler: async (ctx: Ctx, input) => {
        await loadSite(ctx, input.siteId);
        const cipher = await siteCipher(ctx, input.siteId);
        const rows = await ctx.repo.listForms(input.siteId);
        return { forms: await Promise.all(rows.map((row) => toForm(cipher, row))) };
    }
});

export const audienceFormAddFeature = defineSdkFeature({
    ...audienceFormAdd,
    mutates: true,
    access: { level: 'write' },
    handler: async (ctx: Ctx, input) => {
        const site = await loadHomeSite(ctx, input.siteId);
        const count = await ctx.repo.countForms(input.siteId);
        if (count >= AUDIENCE_MAX_FORMS) {
            throw new FeatureError(
                'validation',
                `Un site ne peut pas porter plus de ${AUDIENCE_MAX_FORMS} formulaires.`
            );
        }
        const ref = nameRef(input.name);
        if (await ctx.repo.findFormByName(input.siteId, ref)) {
            throw new FeatureError('validation', 'Un formulaire porte déjà ce nom sur ce site.');
        }
        // Deux questions du même nom rendraient la seconde inatteignable : le
        // schéma est un objet, pas une liste, du côté de l'envoi.
        const names = new Set(input.fields.map((field) => field.name.trim()));
        if (names.size !== input.fields.length) {
            throw new FeatureError('validation', 'Deux champs portent le même nom.');
        }
        if (input.mode === 'strict' && input.fields.length === 0) {
            throw new FeatureError('validation', 'Un formulaire strict sans champ déclaré n’accepterait rien.');
        }

        const cipher = ctx.cipher();
        const id = await ctx.repo.createForm({
            siteId: input.siteId,
            nameRef: ref,
            content: await cipher.encrypt(input.name.trim()),
            mode: input.mode,
            formSchema: await sealSchema(cipher, input.mode, input.fields),
            sortOrder: count
        });
        // Le nom déclaré est celui que l'ingestion cherchera : sans cet oubli, un
        // envoi arrivé avant serait encore refusé pour la vie du processus.
        ingestOf()?.invalidate();
        ctx.audit({
            action: 'audience.formAdd',
            description: `Formulaire de retours « ${input.name.trim()} » déclaré`,
            metadata: { siteId: input.siteId, workspaceId: site.workspace_id }
        });

        const created = await ctx.repo.findForm(id);
        if (!created) throw new FeatureError('not_found', 'Formulaire introuvable');
        return { form: await toForm(cipher, created) };
    }
});

export const audienceFormUpdateFeature = defineSdkFeature({
    ...audienceFormUpdate,
    mutates: true,
    access: { level: 'write' },
    handler: async (ctx: Ctx, input) => {
        const form = await loadHomeForm(ctx, input.formId);
        const ref = nameRef(input.name);
        const clash = await ctx.repo.findFormByName(Number(form.site_id), ref);
        if (clash && Number(clash.id) !== Number(form.id)) {
            throw new FeatureError('validation', 'Un formulaire porte déjà ce nom sur ce site.');
        }

        const cipher = ctx.cipher();
        await ctx.repo.updateForm({
            formId: Number(form.id),
            nameRef: ref,
            content: await cipher.encrypt(input.name.trim()),
            mode: input.mode,
            formSchema: await sealSchema(cipher, input.mode, input.fields),
            open: input.open
        });
        // Le nom fait partie de l'adressage : renommé, c'est ce nouveau nom que le
        // site doit envoyer, et l'ancien créera un canal neuf au prochain envoi.
        ingestOf()?.invalidate();

        const updated = await ctx.repo.findForm(Number(form.id));
        if (!updated) throw new FeatureError('not_found', 'Formulaire introuvable');
        return { form: await toForm(cipher, updated) };
    }
});

export const audienceFormClearFeature = defineSdkFeature({
    ...audienceFormClear,
    mutates: true,
    access: { level: 'write' },
    handler: async (ctx: Ctx, input) => {
        const form = await loadHomeForm(ctx, input.formId);
        const removed = await ctx.repo.clearForm(Number(form.id));
        ingestOf()?.invalidate();
        ctx.audit({
            level: 'warning',
            action: 'audience.formClear',
            description: 'Retours d’un formulaire effacés',
            metadata: { formId: input.formId, removed }
        });
        return { removed };
    }
});

export const audienceFormRemoveFeature = defineSdkFeature({
    ...audienceFormRemove,
    mutates: true,
    access: { level: 'write' },
    handler: async (ctx: Ctx, input) => {
        const form = await loadHomeForm(ctx, input.formId);
        // Retours, libellés et compteurs partent en CASCADE. Le nom reviendra au
        // prochain envoi du site : supprimer efface, fermer est ce qui empêche.
        await ctx.repo.removeForm(Number(form.id));
        ingestOf()?.invalidate();
        ctx.audit({
            level: 'warning',
            action: 'audience.formRemove',
            description: 'Formulaire de retours supprimé, historique compris',
            metadata: { formId: input.formId }
        });
        return { ok: true as const };
    }
});

export const audienceSubmissionListFeature = defineSdkFeature({
    ...audienceSubmissionList,
    handler: async (ctx: Ctx, input) => {
        const form = await loadForm(ctx, input.formId);
        const cipher = await siteCipher(ctx, Number(form.site_id));
        const limit = Math.min(input.limit ?? AUDIENCE_SUBMISSION_PAGE, AUDIENCE_SUBMISSION_PAGE);
        const cursor = parseCursor(input.cursor ?? null);

        // Une ligne de plus que demandé : c'est ce qui dit s'il y a une suite, sans
        // un COUNT sur toute la table à chaque page.
        const rows = await ctx.repo.listSubmissions({
            formId: Number(form.id),
            order: input.order,
            cursorTs: cursor?.ts ?? null,
            cursorId: cursor?.id ?? null,
            limit: limit + 1
        });
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];

        return {
            submissions: await Promise.all(page.map((row) => toSubmission(cipher, row))),
            nextCursor: rows.length > limit && last ? `${Number(last.ts)}:${Number(last.id)}` : null
        };
    }
});

export const audienceSubmissionRemoveFeature = defineSdkFeature({
    ...audienceSubmissionRemove,
    mutates: true,
    access: { level: 'write' },
    handler: async (ctx: Ctx, input) => {
        const row = await ctx.repo.findSubmission(input.submissionId);
        if (!row) throw new FeatureError('not_found', 'Retour introuvable');
        await loadHomeSite(ctx, Number(row.site_id));

        // Les compteurs de répartition sont tenus à la réception : les défaire ici
        // demande de relire ce que ce retour portait et de rejouer les mêmes règles.
        // Sans cela, la vue Résultats compterait indéfiniment des réponses effacées.
        const cipher = ctx.cipher();
        const stored = await readJson<Partial<StoredSubmission>>(cipher, row.content);
        await ctx.repo.removeSubmission(input.submissionId);
        if (stored?.fields) {
            await countAnswers(ctx.repo, cipher, Number(row.form_id), stored.fields, -1);
        }
        // Le compteur dénormalisé du formulaire suit le même sort.
        await ctx.repo.bumpFormSubmissions(Number(row.form_id), -1);
        ingestOf()?.invalidate();
        return { ok: true as const };
    }
});

export const audienceResultsFeature = defineSdkFeature({
    ...audienceResults,
    handler: async (ctx: Ctx, input) => {
        const form = await loadForm(ctx, input.formId);
        const cipher = await siteCipher(ctx, Number(form.site_id));
        const [rows, stored] = await Promise.all([
            ctx.repo.readAnswers(Number(form.id)),
            readJson<Partial<StoredSchema>>(cipher, form.form_schema)
        ]);
        const declared = new Map((stored?.fields ?? []).map((field) => [field.name, field]));

        // Les questions déclarées d'abord, dans l'ordre où on les a écrites, et à
        // zéro tant que personne n'a répondu : « personne n'a répondu » et « cette
        // question n'existe pas » sont deux choses différentes, qu'un comptage seul
        // confond. Les questions découvertes (mode auto) suivent.
        const fields: AudienceResultField[] = [...declared.values()].map((field) => ({
            name: field.name,
            kind: field.kind,
            answered: 0,
            free: 0,
            values: []
        }));
        const byName = new Map(fields.map((field) => [field.name, field]));
        const byField = new Map<number, AudienceResultField>();

        for (const row of rows) {
            const fieldId = Number(row.field_id);
            let field = byField.get(fieldId);
            if (!field) {
                const name = (await readLabel(cipher, row.field_content)) || 'Sans nom';
                field = byName.get(name);
                if (!field) {
                    field = { name, kind: declared.get(name)?.kind ?? null, answered: 0, free: 0, values: [] };
                    byName.set(name, field);
                    fields.push(field);
                }
                byField.set(fieldId, field);
            }
            const count = Number(row.hits);
            field.answered += count;
            if (Number(row.value_id) === 0 || row.value_content === null) {
                field.free += count;
            } else {
                field.values.push({ label: await readLabel(cipher, row.value_content), count });
            }
        }

        return { total: Number(form.submissions), fields };
    }
});

/** `ts:id`, tel que la page précédente l'a rendu. Illisible vaut « depuis le début ». */
function parseCursor(raw: string | null): { ts: number; id: number } | null {
    if (!raw) return null;
    const [ts, id] = raw.split(':').map(Number);
    if (!Number.isInteger(ts) || !Number.isInteger(id)) return null;
    return { ts, id };
}

async function toSubmission(cipher: SdkCipher, row: AudienceSubmissionWithContextRow): Promise<AudienceSubmission> {
    const stored = await readJson<Partial<StoredSubmission>>(cipher, row.content);
    // Un blob illisible ne fait pas échouer la page : la ligne existe, elle est
    // datée, et une ligne vide dit la vérité mieux qu'une erreur sur tout l'écran.
    const context =
        row.session_id === null
            ? null
            : {
                  entryPath: await readOptional(cipher, row.entry_path_content),
                  referrer: await readOptional(cipher, row.referrer_content),
                  browser: await readOptional(cipher, row.browser_content),
                  device: await readOptional(cipher, row.device_content)
              };
    return {
        id: Number(row.id),
        at: Number(row.ts),
        fields: stored?.fields ?? {},
        path: stored?.path ?? '',
        context
    };
}

async function readOptional(cipher: SdkCipher, blob: string | null): Promise<string> {
    return blob === null ? '' : readLabel(cipher, blob);
}
