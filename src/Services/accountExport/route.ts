import { PassThrough } from 'node:stream';

import { err } from '@deveye/types';
import type { FastifyInstance, FastifyReply } from 'fastify';

import { authTransport, readAccessToken } from '@/auth/federation';
import { verifyAccessToken } from '@/auth/jwt';
import type { Database } from '@/db';
import { ORIGINS } from '@/features/_sdk/context';
import { moduleAccountExports, sdkQueryable } from '@/features/_sdk/register';
import { logger } from '@/logger';
import { accountExportedMail } from '@/Services/accountMails';
import type { AuditLog } from '@/Services/AuditLog';
import type Encryption from '@/Services/Encryption';
import { claimExportCipher, discardExportDek } from '@/Services/SecureStore';
import { serverMail } from '@/Services/serverMail';
import { writeAccountExport } from './run';
import { beginExport, endExport, redeemExportTicket } from './tickets';
import { ZipWriter } from './zip';

export const ACCOUNT_EXPORT_PATH = '/api/account/export';

/** Un client qui ne lit plus rien depuis ce temps ne tient plus la clé : l'export s'arrête. */
const STALL_MS = 10 * 60_000;

interface Deps {
    db: Database;
    crypt: Encryption;
    audit: AuditLog;
}

/** Un nom de fichier sûr pour tous les navigateurs, et sa forme UTF-8 pour ceux qui la lisent. */
function disposition(username: string): string {
    const day = new Date().toISOString().slice(0, 10);
    const utf8 = `deveye-${username}-${day}.zip`;
    const ascii = utf8
        .normalize('NFD')
        .replace(/[^\x20-\x7e]/g, '')
        .replace(/["\\]/g, '_');
    return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(utf8)}`;
}

function drained(stream: PassThrough, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const stalled = setTimeout(() => done(new Error('Le client ne lit plus l’archive')), STALL_MS);
        const onAbort = (): void => done(new Error('Téléchargement interrompu'));
        const onDrain = (): void => done(null);
        function done(e: Error | null): void {
            clearTimeout(stalled);
            stream.off('drain', onDrain);
            signal.removeEventListener('abort', onAbort);
            if (e) reject(e);
            else resolve();
        }
        stream.once('drain', onDrain);
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

/**
 * Le téléchargement de l'export des données d'un compte : le lien que
 * `user.exportPrepare` a rendu, une seule fois, par le cookie de la session
 * qui l'a demandé. L'archive s'écrit pendant qu'elle part et n'existe nulle
 * part ailleurs ; la clé prêtée s'efface à la fin comme à l'abandon.
 */
export async function accountExportRoutes(app: FastifyInstance, { db, crypt, audit }: Deps): Promise<void> {
    app.get<{ Querystring: { token?: string } }>(
        ACCOUNT_EXPORT_PATH,
        // Le jeton est dans l'URL : rien ne se journalise. Un HEAD le consommerait sans rien servir.
        { logLevel: 'silent', exposeHeadRoute: false },
        async (req, reply): Promise<FastifyReply> => {
            const refuse = (code: number, why: string): FastifyReply =>
                reply.code(code).header('Cache-Control', 'no-store').send(err('forbidden', why));
            if (authTransport(req) !== 'cookie')
                return refuse(403, 'Ce lien s’ouvre depuis l’app, dans le navigateur de la demande.');
            const access = readAccessToken(req);
            const claims = access ? await verifyAccessToken(access) : null;
            if (!claims || !(await db.refreshTokens.hasLiveSession(claims.sid))) {
                return refuse(401, 'Session expirée : recommencez l’export depuis votre profil.');
            }
            const userId = Number(claims.sub);
            const ticket = req.query.token
                ? redeemExportTicket(req.query.token, (dropped) => discardExportDek(dropped.dekToken))
                : null;
            if (!ticket || ticket.userId !== userId || ticket.sessionId !== claims.sid) {
                if (ticket) discardExportDek(ticket.dekToken);
                return refuse(410, 'Ce lien a déjà servi ou a expiré : recommencez l’export depuis votre profil.');
            }
            if (!beginExport(userId)) {
                discardExportDek(ticket.dekToken);
                return refuse(429, 'Un export est déjà en cours : attendez qu’il finisse.');
            }
            const lent = claimExportCipher(ticket.dekToken, userId);
            const account = await db.users.findById(userId);
            if (!lent || !account) {
                endExport(userId);
                lent?.release();
                return refuse(410, 'Ce lien a expiré : recommencez l’export depuis votre profil.');
            }

            const body = new PassThrough();
            const controller = new AbortController();
            let finished = false;
            reply.raw.on('close', () => {
                if (!finished) controller.abort();
            });
            const write = async (chunk: Buffer): Promise<void> => {
                if (controller.signal.aborted) throw new Error('Téléchargement interrompu');
                if (!body.write(chunk)) await drained(body, controller.signal);
            };
            const started = Date.now();
            let bytes = 0;
            const record = (action: string, description: string, level: 'info' | 'warning'): void =>
                audit.record({
                    source: 'web',
                    category: 'user',
                    action,
                    level,
                    uid: userId,
                    ip: req.ip,
                    description,
                    metadata: { bytes, seconds: Math.round((Date.now() - started) / 1000) }
                });

            void (async () => {
                try {
                    const zip = new ZipWriter(async (chunk) => {
                        bytes += chunk.length;
                        await write(chunk);
                    });
                    const report = await writeAccountExport(
                        zip,
                        {
                            db,
                            crypt,
                            q: sdkQueryable(db.queryable),
                            modules: moduleAccountExports(db, crypt),
                            instance: ORIGINS.app,
                            logger
                        },
                        {
                            userId,
                            leaveOut: new Set(ticket.leaveOut),
                            guarded: lent.cipher,
                            signal: controller.signal,
                            stillValid: async () =>
                                (await db.users.findById(userId)) !== null &&
                                (await db.refreshTokens.hasLiveSession(ticket.sessionId))
                        }
                    );
                    await zip.finish();
                    finished = true;
                    body.end();
                    const failures = report.features.filter((f) => f.errors.length > 0).length;
                    record(
                        'user.exportDone',
                        `Export des données téléchargé${failures ? `, ${failures} fonctionnalité(s) en erreur` : ''}`,
                        'warning'
                    );
                    if (serverMail.configured) {
                        void serverMail
                            .send(
                                account.email,
                                accountExportedMail({
                                    username: account.username,
                                    at: Math.floor(Date.now() / 1000),
                                    site: ORIGINS.site
                                })
                            )
                            .catch((e: Error) =>
                                logger.warn({ err: e.message }, 'Mail d’export des données non envoyé')
                            );
                    }
                } catch (e) {
                    finished = true;
                    body.destroy(e as Error);
                    record('user.exportAborted', `Export des données interrompu : ${(e as Error).message}`, 'info');
                } finally {
                    lent.release();
                    endExport(userId);
                }
            })();

            return (
                reply
                    .header('Content-Type', 'application/zip')
                    .header('Content-Disposition', disposition(account.username))
                    .header('Cache-Control', 'private, no-store')
                    .header('X-Content-Type-Options', 'nosniff')
                    // Un proxy qui mettrait l'archive en tampon l'écrirait sur son disque, en clair.
                    .header('X-Accel-Buffering', 'no')
                    .send(body)
            );
        }
    );
}
