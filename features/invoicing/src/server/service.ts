import { randomBytes } from 'node:crypto';

import type { FeatureService, FeatureServiceDeps, SdkPublicApp } from '@deveye/types/sdk/server';

import { todayIn } from '../contracts/calendar';
import { daysBetween } from '../contracts/calendar';
import { formatMoney } from '../contracts/display';
import {
    invoicingAcceptanceSchema,
    invoicingClientContentSchema,
    invoicingDocContentSchema
} from '../contracts/domain';
import { remainingCents } from '../contracts/money';
import { answerForm, renderMissingPage, renderPublicPage } from './publicPage';
import { paperInputOf } from './paperInput';
import { openJson, settingsOf, type RepoIo } from './_shared';
import type { InvoicingRepo } from './repo';

/**
 * Le service du module : les deux routes publiques du lien qu'un client suit, et
 * les relances. Les routes ne connaissent aucune session : le jeton porté par
 * l'URL est la seule autorisation, et il ne dit rien d'autre que « ce
 * document-là ».
 */

/**
 * La cadence des relances, et l'âge à partir duquel on redit la même chose. Le
 * balayage prend le jour du serveur et non celui de chaque espace : une relance
 * décalée d'un jour pour qui facture depuis l'autre bout du monde est sans
 * conséquence, et une requête par espace en aurait une.
 */
const REMIND_EVERY_MS = 6 * 60 * 60 * 1000;
const REMIND_AGAIN_DAYS = 7;
const REMIND_BATCH = 50;

const PAGE_PATH = '/f/:token';
const ANSWER_PATH = '/api/invoicing/answer';
const EMPTY_CONTENT = invoicingDocContentSchema.parse({});

/** Un jeton d'URL : assez long pour n'être ni deviné ni énuméré. */
export function newToken(): string {
    return randomBytes(24).toString('base64url');
}

function paramOf(bag: unknown, name: string): string {
    const record = bag as Record<string, unknown> | undefined;
    const value = record?.[name];
    return typeof value === 'string' ? value : '';
}

export function createService(deps: FeatureServiceDeps<InvoicingRepo>): FeatureService {
    const ioFor = (workspaceId: number): RepoIo => ({
        repo: deps.repo,
        workspaceId,
        cipher: () => deps.cipherFor(workspaceId)
    });

    /**
     * Les factures échues que personne n'a réglées. On prévient **l'espace**,
     * par ses canaux, et jamais le client : un courriel parti tout seul au nom
     * de l'utilisateur n'est pas une décision que le serveur doit prendre. La
     * relance au client reste un geste, sur la fiche.
     */
    async function remind(): Promise<void> {
        const day = todayIn('UTC');
        const stale = Math.floor(Date.now() / 1000) - REMIND_AGAIN_DAYS * 86_400;
        const rows = await deps.repo.overdueToRemind(day, stale, REMIND_BATCH);
        if (rows.length === 0) return;

        for (const row of rows) {
            const io = ioFor(row.workspace_id);
            const settled = (await deps.repo.settledOf([row.id], row.workspace_id)).get(row.id);
            const rest = remainingCents({
                grossCents: row.total_gross ?? 0,
                paidCents: settled?.paidCents ?? 0,
                creditedCents: settled?.creditedCents ?? 0,
                deductedCents: settled?.deductedCents ?? 0
            });
            if (rest <= 0) continue;

            let client = '';
            if (row.client_snapshot !== null) {
                const snapshot = await openJson(io, row.client_snapshot, invoicingClientContentSchema, null);
                client = snapshot?.name ?? '';
            }
            const late = row.due_on === null ? 0 : -daysBetween(day, row.due_on);

            await deps.deveyeFor(row.workspace_id).notify.send(
                {
                    subject: `Facture ${row.number_label ?? ''} en retard`,
                    body: `${formatMoney(rest, row.currency)} attendus${client.length > 0 ? ` de ${client}` : ''}, en retard de ${late} jour${late > 1 ? 's' : ''}.`
                },
                { itemId: row.client_id ?? undefined }
            );
        }

        // Marqué que l'envoi ait eu lieu ou non : sinon un canal configuré plus
        // tard rejouerait toute l'histoire d'un coup.
        await deps.repo.markReminded(
            rows.map((row) => row.id),
            Math.floor(Date.now() / 1000)
        );
    }

    const ticker = deps.createTicker({ intervalMs: REMIND_EVERY_MS, tick: remind });

    return {
        start() {
            ticker.start();
        },
        stop() {
            ticker.stop();
        },

        publicRoutes(app: SdkPublicApp) {
            app.get(PAGE_PATH, { rateLimit: { max: 120, timeWindow: '1 minute' } }, async (req, reply) => {
                const token = paramOf(req.params, 'token');
                const row = token.length === 0 ? null : await deps.repo.findByToken(token);
                if (row === null) {
                    return reply.code(404).header('content-type', 'text/html; charset=utf-8').send(renderMissingPage());
                }

                const io = ioFor(row.workspace_id);
                const settings = await settingsOf(io);
                const input = await paperInputOf(io, row);
                // Le bloc d'accord ne paraît que sur un devis qui attend encore
                // une réponse : ailleurs, la page est un document, point.
                const form =
                    row.kind === 'quote' && row.status === 'sent'
                        ? answerForm(token, settings.wording.signatureText)
                        : null;

                return reply
                    .header('content-type', 'text/html; charset=utf-8')
                    .header('x-robots-tag', 'noindex, nofollow')
                    .send(renderPublicPage(input, form));
            });

            app.post(ANSWER_PATH, { rateLimit: { max: 10, timeWindow: '1 minute' } }, async (req, reply) => {
                const body = req.body as Record<string, unknown> | undefined;
                const token = typeof body?.token === 'string' ? body.token : '';
                const name = typeof body?.name === 'string' ? body.name.slice(0, 160).trim() : '';
                const status = body?.answer === 'decline' ? 'declined' : 'accepted';

                const row = token.length === 0 ? null : await deps.repo.findByToken(token);
                if (row === null) {
                    return reply.code(404).header('content-type', 'text/html; charset=utf-8').send(renderMissingPage());
                }

                const io = ioFor(row.workspace_id);
                const at = Math.floor(Date.now() / 1000);
                const stored = await openJson(io, row.content, invoicingDocContentSchema, EMPTY_CONTENT);
                const acceptance = invoicingAcceptanceSchema.parse({
                    name,
                    at,
                    ip: req.ip,
                    agent: typeof req.headers?.['user-agent'] === 'string' ? req.headers['user-agent'] : ''
                });
                const content = await io.cipher().encrypt(JSON.stringify({ ...stored, acceptance }));

                const answered = await deps.repo.answerQuote(row.id, token, status, at, content);
                if (answered === 1) {
                    const word = status === 'accepted' ? 'accepté' : 'refusé';
                    // La trame live porte le sujet de la feature : la fiche ouverte
                    // chez l'émetteur se relit d'elle-même, sans qu'il rafraîchisse.
                    deps.live.changed(row.workspace_id);
                    deps.audit({
                        action: status === 'accepted' ? 'invoicing.accepted' : 'invoicing.declined',
                        description: `Devis ${row.number_label ?? ''} ${word} en ligne`,
                        metadata: { id: row.id }
                    });
                    await deps.deveyeFor(row.workspace_id).notify.send(
                        {
                            subject: `Devis ${row.number_label ?? ''} ${word}`,
                            body: `${name.length > 0 ? name : 'Votre client'} vient de ${status === 'accepted' ? 'l’accepter' : 'le refuser'} en ligne.`
                        },
                        { itemId: row.client_id ?? undefined }
                    );
                }

                // Le même geste rejoué ne change rien, et renvoie au même
                // endroit : le document, qui dit lui-même où il en est.
                return reply
                    .code(303)
                    .header('location', `/f/${encodeURIComponent(token)}`)
                    .send();
            });
        }
    };
}
