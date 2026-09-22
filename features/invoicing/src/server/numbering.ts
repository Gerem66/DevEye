import { FeatureError } from '@deveye/types/sdk/server';

import type { DocumentKind, InvoicingSettings } from '../contracts/domain';
import { isDuplicate, type Ctx } from './_shared';

/**
 * La numérotation : chronologique, continue, sans trou, et sans transaction.
 *
 * Le parti pris, qui explique tout le reste : **le numéro n'existe que là où il
 * est écrit**. Un compteur à part avancerait avant que la pièce soit émise, et
 * tout échec entre les deux consommerait un rang qui n'apparaîtrait sur aucun
 * document. Un trou, donc une facturation non conforme.
 *
 * Ici, le rang se lit du plus grand déjà posé, puis s'écrit sur le document sous
 * garde `number IS NULL`. L'index unique `(espace, type, année, rang)` est le
 * juge : deux émissions simultanées ne peuvent pas prendre le même rang, la
 * seconde est refusée et recommence. C'est la même exclusion mutuelle que le
 * verrou de créneaux de Rendez-vous, avec un objet de conflit qui, lui, EST la
 * clé.
 *
 * Deux conséquences assumées :
 *  - un brouillon déjà numéroté (une émission interrompue) ne se supprime plus :
 *    la seule issue est de terminer son émission, et la reprise réutilise son
 *    rang ;
 *  - la séquence se lit à chaque émission, ce qui coûte une requête servie par
 *    l'index.
 */

const ATTEMPTS = 3;

export function seqYearOf(settings: InvoicingSettings, issuedOn: string): number {
    return settings.numberReset === 'yearly' ? Number(issuedOn.slice(0, 4)) : 0;
}

export function prefixOf(settings: InvoicingSettings, kind: DocumentKind): string {
    if (kind === 'quote') return settings.quotePrefix;
    if (kind === 'credit') return settings.creditPrefix;
    return settings.invoicePrefix;
}

export function numberLabel(settings: InvoicingSettings, kind: DocumentKind, seqYear: number, value: number): string {
    const year = seqYear === 0 ? '' : `${seqYear}-`;
    return `${prefixOf(settings, kind)}${year}${String(value).padStart(settings.numberPad, '0')}`;
}

export interface Reserved {
    seqYear: number;
    value: number;
    label: string;
}

/**
 * Attribue son numéro au document, ou reprend celui qu'une émission
 * interrompue lui avait déjà posé.
 */
export async function reserveNumber(
    ctx: Ctx,
    doc: { id: number; kind: string; seq_year: number | null; number: number | null; number_label: string | null },
    settings: InvoicingSettings,
    issuedOn: string
): Promise<Reserved> {
    if (doc.number !== null && doc.seq_year !== null && doc.number_label !== null) {
        return { seqYear: doc.seq_year, value: doc.number, label: doc.number_label };
    }

    const kind = doc.kind as DocumentKind;
    const seqYear = seqYearOf(settings, issuedOn);

    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
        const top = await ctx.repo.maxNumber(ctx.workspaceId, doc.kind, seqYear);
        const value = Math.max(top + 1, settings.numberStart);
        const label = numberLabel(settings, kind, seqYear, value);

        try {
            const posed = await ctx.repo.reserveNumber(doc.id, ctx.workspaceId, seqYear, value, label);
            if (posed === 1) return { seqYear, value, label };
        } catch (error) {
            // Refusé par l'index : une autre émission a pris ce rang entre la
            // lecture et l'écriture. On relit et on recommence.
            if (!isDuplicate(error)) throw error;
            continue;
        }

        // Aucune ligne touchée : quelqu'un a posé un numéro sur CE document
        // entre-temps. Le sien fait foi.
        const current = await ctx.repo.findDoc(doc.id, ctx.workspaceId);
        if (current?.number !== null && current?.seq_year !== null && current?.number_label != null) {
            return { seqYear: current.seq_year, value: current.number, label: current.number_label };
        }
    }

    throw new FeatureError(
        'conflict',
        'Le numéro n’a pas pu être attribué : plusieurs émissions se sont croisées. Réessayez.'
    );
}
