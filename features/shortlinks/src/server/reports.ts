import type { SdkServerKeys } from '@deveye/types/sdk/server';
import { z } from 'zod';

import { shortlinkReportReasonSchema, type ShortlinkReport } from '../contracts/domain';
import type { ReportRow } from './repo';

/**
 * Un signalement, scellé par la clé du serveur et non par celle d'un espace :
 * il se lit sans aucun espace, et survit au lien comme à son auteur. Le
 * contexte lie le blob à sa référence : recopié sur une autre ligne, il ne s'ouvre pas.
 */

export const reportContentSchema = z.object({
    url: z.string(),
    title: z.string(),
    target: z.string(),
    message: z.string(),
    name: z.string(),
    email: z.string(),
    ip: z.string()
});
export type ReportContent = z.infer<typeof reportContentSchema>;

export const reportContext = (ref: string) => `ft_shortlinks_reports:content:${ref}`;

export function sealReport(keys: SdkServerKeys, ref: string, content: ReportContent): string {
    return keys.sealBytes(Buffer.from(JSON.stringify(content), 'utf8'), reportContext(ref));
}

export function openReport(keys: SdkServerKeys, row: Pick<ReportRow, 'ref' | 'content'>): ReportContent | null {
    const bytes = keys.openBytes(row.content, reportContext(row.ref));
    if (bytes === null) return null;
    try {
        const parsed = reportContentSchema.safeParse(JSON.parse(Buffer.from(bytes).toString('utf8')));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

/** `origin` : l'adresse e-mail et l'IP du signalant, que seul un administrateur lit. */
export function reportView(keys: SdkServerKeys, row: ReportRow, origin: boolean): ShortlinkReport {
    const content = openReport(keys, row);
    const reason = shortlinkReportReasonSchema.safeParse(row.reason);
    return {
        id: row.id,
        ref: row.ref,
        linkId: row.link_id,
        linkTitle: content?.title ?? '',
        url: content?.url ?? '',
        target: content?.target ?? '',
        reason: reason.success ? reason.data : 'other',
        message: content?.message ?? 'Contenu illisible : les clés du serveur ont changé.',
        reporterName: content?.name ?? '',
        reporterEmail: origin ? (content?.email ?? '') : null,
        ip: origin ? (content?.ip ?? '') : null,
        status: row.status,
        decision: row.decision,
        linkBlocked: row.link_blocked_at !== null,
        created: Number(row.created),
        closedAt: row.closed_at === null ? null : Number(row.closed_at)
    };
}
