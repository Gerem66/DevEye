import { defineSdkFeature, FeatureError, type SdkFeatureContext } from '@deveye/types/sdk/server';

import { sourceOf, targetOf } from '../contracts/catalogue';
import {
    convertCancel,
    convertCapabilities,
    convertCreate,
    convertDownload,
    convertList,
    convertRates,
    convertRemove,
    convertSettingsGet,
    convertSettingsSet
} from '../contracts/commands';
import { convertSettingsSchema, DEFAULT_SETTINGS } from '../contracts/domain';
import { resolveOptions } from '../contracts/options';
import { abortJob, formatBytes, now, SETTINGS_KEY, toJob } from './_shared';
import { engineFamilies } from './engines';
import { env } from './env';
import { isStale } from './fx';
import type { ConvertRepo, JobRow } from './repo';
import { DOWNLOAD_PATH, UPLOAD_PATH, type ConvertTicket } from './routes';
import { freeBytes, removeJobDir } from './storage';

type Ctx = SdkFeatureContext<ConvertRepo>;

const LIST_MAX = 50;
const DOWNLOAD_TICKET_SECONDS = 120;
/** L'entrée, la sortie en cours d'écriture, et les fichiers de travail de l'outil. */
const DISK_MARGIN = 3;

/** Le plus petit du mur du serveur et de l'offre du propriétaire de l'espace. */
async function maxFileBytes(ctx: Ctx): Promise<number> {
    const plan = await ctx.quota.limit('fileBytes');
    return plan === null ? env.CONVERT_MAX_FILE_BYTES : Math.min(plan, env.CONVERT_MAX_FILE_BYTES);
}

/** Le travail d'un membre. Celui d'un autre n'existe pas pour lui. */
async function ownJob(ctx: Ctx, jobId: number): Promise<JobRow> {
    const row = await ctx.repo.find(jobId, ctx.workspaceId);
    if (!row || row.user_id !== ctx.userId) throw new FeatureError('not_found', 'Conversion introuvable.');
    return row;
}

export const convertHandlers = [
    defineSdkFeature({
        ...convertCapabilities,
        handler: async (ctx: Ctx) => ({
            families: [...engineFamilies()],
            maxFileBytes: await maxFileBytes(ctx),
            resultTtlSeconds: env.CONVERT_RESULT_TTL_SECONDS
        })
    }),
    defineSdkFeature({
        ...convertList,
        handler: async (ctx: Ctx) => {
            const rows = await ctx.repo.list(ctx.workspaceId, ctx.userId, LIST_MAX);
            const cipher = ctx.cipher();
            return { jobs: await Promise.all(rows.map((row) => toJob(row, cipher))) };
        }
    }),
    defineSdkFeature({
        ...convertCreate,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            const source = sourceOf(input.kind, input.sourceFormat);
            const target = targetOf(input.kind, input.sourceFormat, input.targetFormat);
            if (!source || !target) throw new FeatureError('validation', 'Cette conversion n’existe pas.');

            const family = engineFamilies().find((f) => f.kind === input.kind);
            if (!family?.available) {
                throw new FeatureError(
                    'conflict',
                    family?.reason ?? 'Cette conversion n’est pas disponible sur ce serveur.'
                );
            }
            if (family.missingSources.includes(source.id) || family.missingTargets.includes(target.id)) {
                throw new FeatureError(
                    'conflict',
                    'Ce format n’est pas pris en charge par les outils installés sur ce serveur.'
                );
            }

            if (input.declaredBytes > env.CONVERT_MAX_FILE_BYTES) {
                throw new FeatureError(
                    'validation',
                    `Fichier trop lourd : ${formatBytes(env.CONVERT_MAX_FILE_BYTES)} au plus sur ce serveur.`
                );
            }
            // Une taille et non un décompte : ce que ce fichier pèserait, contre la limite de l'offre.
            await ctx.quota.assert('fileBytes', async () => input.declaredBytes);
            await ctx.quota.assert('activeJobs', async (owned) => (await ctx.repo.openJobs(owned)) + 1);
            // Le poids du résultat ne se connaît pas encore : on refuse seulement quand la réserve est déjà pleine.
            // La conversion, elle, s'arrêtera si elle la dépasse.
            await ctx.quota.assert('resultBytes', async (owned) => (await ctx.repo.resultBytes(owned)) + 1);

            const held = await ctx.repo.heldBytes(ctx.workspaceId);
            if (held + input.declaredBytes > env.CONVERT_WORKSPACE_QUOTA_BYTES) {
                throw new FeatureError(
                    'conflict',
                    'Trop de conversions en attente dans cet espace : retirer des résultats déjà récupérés, ou patienter.'
                );
            }
            if ((await freeBytes()) < input.declaredBytes * DISK_MARGIN + env.CONVERT_DISK_FLOOR_BYTES) {
                throw new FeatureError('conflict', 'Le serveur manque de place pour ce fichier. Réessayer plus tard.');
            }

            const id = await ctx.repo.insert({
                workspaceId: ctx.workspaceId,
                userId: ctx.userId,
                kind: input.kind,
                sourceFormat: source.id,
                targetFormat: target.id,
                options: resolveOptions(target.options, input.options),
                originalNameEnc: await ctx.cipher().encrypt(input.originalName),
                declaredBytes: input.declaredBytes,
                at: now()
            });
            const ticket: ConvertTicket = { jobId: id, purpose: 'upload' };
            const token = await ctx.secrecy.ticket(ticket, { ttlSeconds: env.CONVERT_UPLOAD_TTL_SECONDS });
            // Jamais le nom du fichier : le journal n'est pas scellé, lui.
            ctx.audit({
                action: 'convert.create',
                description: `Conversion ${source.label} vers ${target.label} ouverte`,
                metadata: {
                    jobId: id,
                    kind: input.kind,
                    source: source.id,
                    target: target.id,
                    bytes: input.declaredBytes
                }
            });
            const row = (await ctx.repo.find(id, ctx.workspaceId)) as JobRow;
            return {
                job: await toJob(row, ctx.cipher()),
                uploadUrl: `${UPLOAD_PATH}?token=${encodeURIComponent(token)}`
            };
        }
    }),
    defineSdkFeature({
        ...convertCancel,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            await ownJob(ctx, input.jobId);
            if (await ctx.repo.cancel(input.jobId, ctx.workspaceId, now())) {
                abortJob(input.jobId);
                await removeJobDir(ctx.workspaceId, input.jobId);
            }
            return { job: await toJob(await ownJob(ctx, input.jobId), ctx.cipher()) };
        }
    }),
    defineSdkFeature({
        ...convertDownload,
        handler: async (ctx: Ctx, input) => {
            const row = await ownJob(ctx, input.jobId);
            if (row.phase !== 'done' || Number(row.expires_at) <= now()) {
                throw new FeatureError('conflict', 'Ce résultat n’est plus disponible.');
            }
            const ticket: ConvertTicket = { jobId: row.id, purpose: 'download' };
            const token = await ctx.secrecy.ticket(ticket, { ttlSeconds: DOWNLOAD_TICKET_SECONDS });
            return { url: `${DOWNLOAD_PATH}?token=${encodeURIComponent(token)}` };
        }
    }),
    defineSdkFeature({
        ...convertRemove,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            await ownJob(ctx, input.jobId);
            const removed = await ctx.repo.remove(input.jobId, ctx.workspaceId);
            if (!removed) throw new FeatureError('conflict', 'Cette conversion est en cours : l’annuler d’abord.');
            await removeJobDir(ctx.workspaceId, input.jobId);
            return { removed };
        }
    }),
    defineSdkFeature({
        ...convertRates,
        handler: async (ctx: Ctx) => {
            const [stored, state] = await Promise.all([ctx.repo.rates(), ctx.repo.fxState()]);
            return {
                asOf: stored.asOf,
                rates: stored.rates,
                stale: isStale(state.lastSuccessAt, now(), env.CONVERT_FX_REFRESH_SECONDS)
            };
        }
    }),
    defineSdkFeature({
        ...convertSettingsGet,
        handler: async (ctx: Ctx) => ({
            settings: (await ctx.store.getJson(SETTINGS_KEY, convertSettingsSchema)) ?? DEFAULT_SETTINGS
        })
    }),
    defineSdkFeature({
        ...convertSettingsSet,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            // En clair : le service les relit sans session, et rien ici n'est sensible.
            await ctx.store.putJson(SETTINGS_KEY, convertSettingsSchema, input.settings, { encryption: 'none' });
            return { settings: input.settings };
        }
    })
];
