import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { pipeline } from 'node:stream/promises';

import type { FeatureServiceDeps, SdkPublicApp } from '@deveye/types/sdk/server';
import { z } from 'zod';

import { outputName, sourceOf, targetOf } from '../contracts/catalogue';
import { formatBytes, now, wakeQueue } from './_shared';
import { probeInput } from './engines';
import { env } from './env';
import type { ConvertRepo } from './repo';
import { ConvertFailure } from './spawn';
import { ensureJobDir, fileSize, jobPaths, removeJobDir } from './storage';

/**
 * Les deux portes HTTP du module, sur l'origine de l'app seulement : la montée
 * du fichier, en flux, et la descente du résultat. Aucune n'a de session : ce
 * qui les autorise est un ticket signé par l'hôte, qui lie l'appelant, son
 * espace et UN travail.
 */

export const UPLOAD_PATH = '/api/convert/upload';
export const DOWNLOAD_PATH = '/api/convert/result';

export const convertTicketSchema = z.object({
    jobId: z.number().int().positive(),
    purpose: z.enum(['upload', 'download'])
});
export type ConvertTicket = z.infer<typeof convertTicketSchema>;

const querySchema = z.object({ token: z.string().min(1) });

export type ConvertRouteDeps = Pick<
    FeatureServiceDeps<ConvertRepo>,
    'repo' | 'secrecy' | 'quotaFor' | 'live' | 'logger'
>;

/** `filename=` réduit à de l'ASCII sûr (un retour chariot ferait échouer la réponse), le vrai nom dans `filename*`. */
export function contentDisposition(filename: string): string {
    const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '');
    return `attachment; filename="${ascii.trim() || 'fichier'}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

async function redeem(deps: ConvertRouteDeps, query: unknown, purpose: ConvertTicket['purpose']) {
    const parsed = querySchema.safeParse(query);
    if (!parsed.success) return null;
    const ticket = await deps.secrecy.redeem(parsed.data.token);
    const claims = ticket ? convertTicketSchema.safeParse(ticket.payload) : null;
    if (!ticket || !claims?.success || claims.data.purpose !== purpose) return null;
    return { ticket, jobId: claims.data.jobId };
}

export function convertRoutes(app: SdkPublicApp, deps: ConvertRouteDeps): void {
    app.postStream(
        UPLOAD_PATH,
        // Le plafond de débit compte des requêtes, et un envoi de 5 Gio en est
        // une : ce qui protège le disque est le ticket, l'état de la ligne et
        // le compteur d'octets de l'hôte.
        { exposure: 'app', maxBytes: env.CONVERT_MAX_FILE_BYTES, rateLimit: { max: 30, timeWindow: '1 minute' } },
        async (req, reply) => {
            const access = await redeem(deps, req.query, 'upload');
            if (!access) return reply.code(401).send({ error: 'invalid_token' });
            const { ticket, jobId } = access;

            // Le ticket est rejouable tant qu'il vit : c'est cette transition,
            // et elle seule, qui interdit deux montées du même travail.
            const job = await deps.repo.claimForUpload(jobId, ticket.workspaceId);
            if (!job || job.user_id !== ticket.userId) return reply.code(409).send({ error: 'not_awaiting_upload' });

            const paths = jobPaths(ticket.workspaceId, jobId);
            const refuse = async (failure: ConvertFailure, status: number) => {
                await removeJobDir(ticket.workspaceId, jobId);
                await deps.repo.fail(jobId, failure.code, await ticket.cipher.server.encrypt(failure.message), now());
                deps.live.changed(ticket.workspaceId);
                return reply.code(status).send({ error: failure.code, message: failure.message });
            };

            const plan = await deps.quotaFor(ticket.workspaceId).limit('fileBytes');
            const cap = plan === null ? env.CONVERT_MAX_FILE_BYTES : Math.min(plan, env.CONVERT_MAX_FILE_BYTES);
            const tooLarge = new ConvertFailure('too_large', `Fichier trop lourd : ${formatBytes(cap)} au plus.`);
            if ((req.body.contentLength ?? 0) > cap) return refuse(tooLarge, 413);

            try {
                await ensureJobDir(paths);
                let received = 0;
                await pipeline(
                    req.body.bytes(),
                    async function* (source: AsyncIterable<Buffer>) {
                        for await (const chunk of source) {
                            received += chunk.length;
                            if (received > cap) throw tooLarge;
                            yield chunk;
                        }
                    },
                    createWriteStream(paths.inputPart)
                );
                if (received === 0) throw new ConvertFailure('corrupt', 'Le fichier reçu est vide.');
                await fs.rename(paths.inputPart, paths.input);

                const source = sourceOf(job.kind, job.source_format);
                if (!source) throw new ConvertFailure('unsupported', 'Ce format n’est plus pris en charge.');
                await probeInput(job.kind, source, paths, received);

                await deps.repo.queue(jobId, received);
                deps.live.changed(ticket.workspaceId);
                wakeQueue();
                return reply.send({ ok: true });
            } catch (e) {
                if (e instanceof ConvertFailure) return refuse(e, e.code === 'too_large' ? 413 : 422);
                deps.logger.warn({ err: e, jobId }, 'convert: réception du fichier interrompue');
                return refuse(new ConvertFailure('upload_interrupted', 'L’envoi du fichier a été interrompu.'), 400);
            }
        }
    );

    app.get(DOWNLOAD_PATH, { exposure: 'app' }, async (req, reply) => {
        const access = await redeem(deps, req.query, 'download');
        if (!access) return reply.code(401).send({ error: 'invalid_token' });
        const { ticket, jobId } = access;

        const job = await deps.repo.find(jobId, ticket.workspaceId);
        if (!job || job.user_id !== ticket.userId || job.phase !== 'done' || Number(job.expires_at) <= now()) {
            return reply.code(404).send({ error: 'not_found' });
        }
        const target = targetOf(job.kind, job.source_format, job.target_format);
        const output = jobPaths(ticket.workspaceId, jobId).output;
        const size = await fileSize(output);
        if (size === null) {
            // L'écran montrait encore « Prêt » : la ligne dit désormais ce qu'il en est.
            if (await deps.repo.markLost(jobId, 'done', now())) deps.live.changed(ticket.workspaceId);
            return reply.code(404).send({ error: 'not_found' });
        }
        if (!target) return reply.code(404).send({ error: 'not_found' });

        const original = (await ticket.cipher.server.tryDecrypt(job.original_name_enc)) ?? 'fichier';
        // Le type vient du catalogue, jamais de l'envoi, et toujours en pièce
        // jointe : un HTML ou un SVG produit ne s'exécute pas sur l'origine de l'app.
        reply.header('Content-Type', target.mime);
        reply.header('Content-Length', String(size));
        reply.header('Content-Disposition', contentDisposition(outputName(original, target)));
        reply.header('Cache-Control', 'private, no-store');
        return reply.send(createReadStream(output));
    });
}
