import {
    audienceFormClear,
    audienceFormList,
    audienceFormRemove,
    audienceFormUpdate,
    audienceResults,
    audienceSubmissionList,
    audienceSubmissionRemove
} from '../contracts/commands';
import {
    AUDIENCE_SUBMISSION_PAGE,
    type AudienceFieldValue,
    type AudienceForm,
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
 * Rien ici ne crée de formulaire : un canal naît de sa première réception, par
 * la porte publique. Ces commandes ne font que le renommer, le fermer, le vider
 * et le lire.
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

async function toForm(cipher: SdkCipher, row: AudienceFormRow): Promise<AudienceForm> {
    return {
        id: Number(row.id),
        name: (await readLabel(cipher, row.content)) || 'Sans nom',
        open: Number(row.is_open) === 1,
        submissions: Number(row.submissions),
        lastAt: row.last_at === null ? null : Number(row.last_at),
        created: Number(row.created)
    };
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
        await ctx.repo.updateForm(Number(form.id), ref, await cipher.encrypt(input.name.trim()), input.open);
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
        const rows = await ctx.repo.readAnswers(Number(form.id));

        // Les lignes arrivent groupées par question (ordre d'apparition) puis par
        // fréquence : le regroupement suit la lecture, sans tri supplémentaire.
        const fields: AudienceResultField[] = [];
        const byField = new Map<number, AudienceResultField>();
        for (const row of rows) {
            const fieldId = Number(row.field_id);
            let field = byField.get(fieldId);
            if (!field) {
                field = {
                    name: (await readLabel(cipher, row.field_content)) || 'Sans nom',
                    answered: 0,
                    free: 0,
                    values: []
                };
                byField.set(fieldId, field);
                fields.push(field);
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
