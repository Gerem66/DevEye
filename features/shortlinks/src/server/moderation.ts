import { defineSdkFeature, FeatureError } from '@deveye/types/sdk/server';

import { shortlinksReportDecide, shortlinksReports, shortlinksRestore } from '../contracts/commands';
import { SHORTLINK_REPORT_REASON_LABELS, shortlinkReportReasonSchema } from '../contracts/domain';
import { now, runtime, type Ctx } from './_shared';
import { takedownMail } from './mails';
import type { LinkRow, ReportRow } from './repo';
import { openReport, reportView } from './reports';

/**
 * La modération : ce que l'administration du service lit et décide des
 * signalements, tous espaces confondus. Retirer un lien le coupe pour tout le
 * monde sans rien supprimer, et prévient son auteur avec la raison. Le compte,
 * lui, n'est jamais coupé : on sanctionne un lien, pas un usage.
 */

const ADMIN = { scope: 'account', admin: true } as const;
const LIST_LIMIT = 200;

async function requireReport(ctx: Ctx, id: number): Promise<ReportRow> {
    const row = await ctx.repo.reports.find(id);
    if (row === null) throw new FeatureError('not_found', 'Ce signalement n’existe plus.');
    return row;
}

async function fresh(ctx: Ctx, id: number) {
    return reportView(ctx.keys, await requireReport(ctx, id));
}

/** L'auteur l'apprend par mail, et l'espace par ses canaux. Aucun des deux ne doit bloquer la décision. */
async function tellAuthor(ctx: Ctx, report: ReportRow, link: LinkRow, note: string) {
    const service = runtime();
    if (service === null) return;
    const content = openReport(ctx.keys, report);
    const title = content?.title ?? '';
    const url = content?.url ?? '';
    try {
        if (link.user_id !== null && service.deps.accountMail.configured) {
            await service.deps.accountMail.send(
                link.user_id,
                takedownMail({ title, url, note, ref: report.ref, origins: ctx.origins })
            );
        }
    } catch (error) {
        ctx.logger.warn({ err: error, ref: report.ref }, 'shortlinks: avis de retrait non parti par mail');
    }
    await service.deps
        .deveyeFor(link.workspace_id)
        .notify.send(
            {
                subject: `Lien retiré : ${title || url}`,
                body: `L’administration du service a retiré ce lien à la suite d’un signalement. ${note.length > 0 ? `Motif : ${note}` : ''}`.trim()
            },
            { itemId: link.id }
        )
        .catch((error: unknown) => ctx.logger.warn({ err: error }, 'shortlinks: avis de retrait non parti'));
}

export const moderationHandlers = [
    defineSdkFeature({
        ...shortlinksReports,
        access: ADMIN,
        handler: async (ctx: Ctx, input) => {
            const [rows, open] = await Promise.all([
                ctx.repo.reports.list(input.status, LIST_LIMIT),
                ctx.repo.reports.countOpen()
            ]);
            return { reports: rows.map((row) => reportView(ctx.keys, row)), open };
        }
    }),

    defineSdkFeature({
        ...shortlinksReportDecide,
        access: ADMIN,
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            const report = await requireReport(ctx, input.reportId);
            if (report.status !== 'open') throw new FeatureError('conflict', 'Ce signalement a déjà été traité.');
            const at = now();

            if (input.decision === 'dismiss') {
                await ctx.repo.reports.close(report.id, 'dismissed', input.note, ctx.userId, at);
                ctx.audit({
                    action: 'shortlinks.reportDismiss',
                    description: `Signalement ${report.ref} classé sans suite.`,
                    metadata: { reportId: report.id }
                });
                return { report: await fresh(ctx, report.id) };
            }

            const link = report.link_id === null ? null : await ctx.repo.links.findById(report.link_id);
            if (link === null) throw new FeatureError('conflict', 'Ce lien a déjà été supprimé par son auteur.');
            const motive = shortlinkReportReasonSchema.safeParse(report.reason);
            const note =
                input.note.length > 0
                    ? input.note
                    : SHORTLINK_REPORT_REASON_LABELS[motive.success ? motive.data : 'other'];
            if (link.blocked_at === null) await ctx.repo.links.block(link.id, at, note);
            await ctx.repo.reports.close(report.id, 'actioned', note, ctx.userId, at);

            const service = runtime();
            service?.forget(link.id);
            service?.deps.live.changed(link.workspace_id);
            ctx.audit({
                action: 'shortlinks.block',
                description: `Lien court retiré à la suite du signalement ${report.ref}.`,
                level: 'warning',
                metadata: { reportId: report.id, linkId: link.id, workspaceId: link.workspace_id }
            });
            await tellAuthor(ctx, report, link, note);
            return { report: await fresh(ctx, report.id) };
        }
    }),

    defineSdkFeature({
        ...shortlinksRestore,
        access: ADMIN,
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            const report = await requireReport(ctx, input.reportId);
            const link = report.link_id === null ? null : await ctx.repo.links.findById(report.link_id);
            if (link === null) throw new FeatureError('conflict', 'Ce lien n’existe plus.');
            if (link.blocked_at !== null) {
                await ctx.repo.links.unblock(link.id);
                const service = runtime();
                service?.forget(link.id);
                service?.deps.live.changed(link.workspace_id);
                ctx.audit({
                    action: 'shortlinks.restore',
                    description: `Lien court remis en service après le signalement ${report.ref}.`,
                    level: 'warning',
                    metadata: { reportId: report.id, linkId: link.id }
                });
            }
            return { report: await fresh(ctx, report.id) };
        }
    })
];
