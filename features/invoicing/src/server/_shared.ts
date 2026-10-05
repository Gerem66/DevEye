import { FeatureError, type SdkCipher, type SdkFeatureContext, type SdkQuota } from '@deveye/types/sdk/server';
import type { ZodType } from 'zod';

import { addDays, dueDateOf, todayIn } from '../contracts/calendar';
import { DEFAULT_SETTINGS } from '../contracts/defaults';
import {
    invoicingSettingsSchema,
    type DocumentKind,
    type InvoicingSettings,
    type InvoicingSettingsSection
} from '../contracts/domain';
import type { InvoicingDocRow, InvoicingRepo, InvoicingSettingsRow } from './repo';

export type Ctx = SdkFeatureContext<InvoicingRepo>;

/**
 * Le strict nécessaire pour sceller et desceller. Le contexte d'une commande le
 * satisfait, et un service le fabrique avec `deps.cipherFor(espace)` : c'est ce
 * qui permet à la page publique de rendre le même document que l'écran, sans
 * session.
 */
export interface CipherIo {
    cipher(mode?: 'server' | 'private'): SdkCipher;
}

/** Le même, plus de quoi lire : ce dont une projection a besoin. */
export interface RepoIo extends CipherIo {
    repo: InvoicingRepo;
    workspaceId: number;
}

/** Le niveau d'accès de toute écriture. Le `read` est déjà garanti par le dispatcheur. */
export const WRITE = { level: 'write' } as const;

/** Scelle un objet à l'étage ouvert : la donnée appartient à l'espace, pas à une session. */
export async function seal(io: CipherIo, value: unknown): Promise<string> {
    return io.cipher().encrypt(JSON.stringify(value));
}

/**
 * Descelle et valide, ou rend le repli. `tryDecrypt` et non `decrypt` : une
 * ligne scellée sous une clé serveur précédente ne doit pas casser l'écran, elle
 * doit se lire comme vide.
 */
export async function openJson<T>(io: CipherIo, blob: string, schema: ZodType<T>, fallback: T): Promise<T> {
    const plain = await io.cipher().tryDecrypt(blob);
    if (plain === null) return fallback;
    const parsed = schema.safeParse(JSON.parse(plain));
    return parsed.success ? parsed.data : fallback;
}

/** Une insertion refusée par un index unique, sans importer le pilote. */
export function isDuplicate(error: unknown): boolean {
    const bag = error as { code?: unknown; errno?: unknown };
    return bag?.code === 'ER_DUP_ENTRY' || bag?.errno === 1062;
}

/**
 * Les réglages de l'espace. **Une lecture n'écrit jamais** : un espace qui n'a
 * jamais ouvert ses réglages lit ceux du code, et la ligne naît au premier
 * enregistrement.
 */
export async function settingsOf(io: RepoIo): Promise<InvoicingSettings> {
    const row = await io.repo.getSettings(io.workspaceId);
    if (row === null) return DEFAULT_SETTINGS;

    const content = await openJson(io, row.content, invoicingSettingsSchema.pick({ issuer: true, wording: true }), {
        issuer: DEFAULT_SETTINGS.issuer,
        wording: DEFAULT_SETTINGS.wording
    });

    const parsed = invoicingSettingsSchema.safeParse({
        currency: row.currency,
        timeZone: row.time_zone,
        vatRegime: row.vat_regime,
        defaultVatBp: row.default_vat_bp,
        paymentTermsDays: row.payment_terms_days,
        quoteValidityDays: row.quote_validity_days,
        defaultDepositBp: row.default_deposit_bp,
        quotePrefix: row.quote_prefix,
        invoicePrefix: row.invoice_prefix,
        creditPrefix: row.credit_prefix,
        numberReset: row.number_reset,
        numberStart: row.number_start,
        numberPad: row.number_pad,
        mailSenderId: row.mail_sender_id,
        domainId: row.domain_id,
        issuer: content.issuer,
        wording: content.wording
    });
    // Une colonne qu'une migration future élargirait sans que le schéma suive
    // vaut mieux lue par défaut qu'en panne.
    return parsed.success ? parsed.data : DEFAULT_SETTINGS;
}

/** La ligne à écrire, texte libre déjà scellé à part. */
export function settingsRow(settings: InvoicingSettings, content: string): InvoicingSettingsRow {
    return {
        currency: settings.currency,
        time_zone: settings.timeZone,
        vat_regime: settings.vatRegime,
        default_vat_bp: settings.defaultVatBp,
        payment_terms_days: settings.paymentTermsDays,
        quote_validity_days: settings.quoteValidityDays,
        default_deposit_bp: settings.defaultDepositBp,
        quote_prefix: settings.quotePrefix,
        invoice_prefix: settings.invoicePrefix,
        credit_prefix: settings.creditPrefix,
        number_reset: settings.numberReset,
        number_start: settings.numberStart,
        number_pad: settings.numberPad,
        mail_sender_id: settings.mailSenderId,
        domain_id: settings.domainId,
        content
    };
}

/**
 * L'origine des liens remis aux clients : le domaine choisi dans les réglages
 * tant qu'il est vérifié, l'adresse de DevEye sinon. Un lien déjà remis sur
 * l'une reste bon sur l'autre, le jeton seul désignant le document.
 */
export async function publicOriginOf(ctx: Ctx, settings: InvoicingSettings): Promise<string> {
    if (settings.domainId === null) return ctx.origins.public;
    const domain = await ctx.domains.get(settings.domainId);
    return domain?.verified ? `https://${domain.host}` : ctx.origins.public;
}

/** Le jour courant dans le fuseau de l'espace, jamais celui du processus. */
export function today(settings: InvoicingSettings): string {
    return todayIn(settings.timeZone);
}

/**
 * Les dates d'un brouillon neuf : un devis dit jusqu'à quand il vaut, une
 * facture ou un avoir quand il se règle. Le délai du client prime sur celui de
 * l'espace.
 */
export async function draftDeadlines(
    io: RepoIo,
    settings: InvoicingSettings,
    kind: DocumentKind,
    clientId: number | null
): Promise<{ due_on: string | null; valid_until: string | null }> {
    const day = today(settings);
    if (kind === 'quote') return { due_on: null, valid_until: addDays(day, settings.quoteValidityDays) };
    const client = clientId === null ? null : await io.repo.findClient(clientId, io.workspaceId);
    return { due_on: dueDateOf(day, client?.payment_terms_days ?? settings.paymentTermsDays), valid_until: null };
}

export function now(): number {
    return Math.floor(Date.now() / 1000);
}

/**
 * Une erreur dont la réponse est dans les réglages. La section voyage dans les
 * détails plutôt que dans la phrase : l'écran monte alors le bouton qui ouvre le
 * bon onglet, et personne n'a à retrouver ce chemin au moment où il est bloqué.
 */
export function settingsError(
    code: 'validation' | 'conflict',
    message: string,
    section: InvoicingSettingsSection
): FeatureError {
    return new FeatureError(code, message, { settingsSection: section });
}

/**
 * Une erreur dont la réponse est dans la fiche du client, et non dans les
 * réglages de la feature : l'écran monte le bouton qui l'ouvre, puisqu'il sait
 * déjà de quel client il s'agit.
 */
export function clientError(code: 'validation' | 'conflict', message: string): FeatureError {
    return new FeatureError(code, message, { clientFiche: true });
}

/** Le document, ou l'erreur qui dit qu'il n'est pas d'ici. Partagé par tous les handlers. */
export async function docOr404(ctx: Ctx, id: number): Promise<InvoicingDocRow> {
    const row = await ctx.repo.findDoc(id, ctx.workspaceId);
    if (row === null) throw new FeatureError('not_found', 'Ce document n’existe pas dans cet espace.');
    return row;
}

/**
 * Le client d'un document est l'élément de la feature : c'est par lui qu'un rôle
 * ouvre ou ferme l'accès. Un document sans client n'est restreint par personne,
 * ce qui est le cas d'un brouillon qu'on vient de commencer.
 */
export async function assertClient(ctx: Ctx, clientId: number | null, level: 'read' | 'write'): Promise<void> {
    if (clientId === null) return;
    await ctx.items.assert(String(clientId), level);
}

/** Le contrat de `SdkQuota`, réduit à ce dont les handlers ont besoin. */
export type Quota = Pick<SdkQuota, 'limit' | 'assert' | 'usage'>;
