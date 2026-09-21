import { promises as fs } from 'node:fs';

import type { FeatureService, FeatureServiceDeps } from '@deveye/types/sdk/server';

import { outputName, sourceOf, targetOf } from '../contracts/catalogue';
import {
    CONVERT_PROGRESS_EVENT,
    convertSettingsSchema,
    DEFAULT_SETTINGS,
    type ConvertProgress
} from '../contracts/domain';
import { optionValuesSchema, resolveOptions } from '../contracts/options';
import { formatBytes, now, setJobAborter, setQueueWaker, SETTINGS_KEY } from './_shared';
import { convert, probeEngines, probeInput } from './engines';
import { env } from './env';
import { frankfurter, refreshRates, type FxClient } from './fx';
import type { ConvertRepo, JobRow } from './repo';
import { convertRoutes } from './routes';
import { ConvertCanceled, ConvertFailure } from './spawn';
import { fileSize, freeBytes, jobPaths, probeStorage, removeJobDir, sweepStorage } from './storage';

/**
 * La file de conversion : un travail à la fois. Une conversion occupe le
 * processeur et le disque que toutes les fonctionnalités partagent, et deux
 * vidéos de front suffiraient à faire tousser tout le reste.
 */

const PUBLISH_EVERY_MS = 1000;
const PERSIST_EVERY_MS = 5000;
/** Les travaux au repos (échec, annulation, résultat parti) quittent la base après ce délai. */
const KEPT_SECONDS = 7 * 86_400;

/** La couture de test : la source des taux, sans réseau. */
export interface ConvertServiceSeam {
    fx?: FxClient;
}

export function createService(deps: FeatureServiceDeps<ConvertRepo>, seam: ConvertServiceSeam = {}): FeatureService {
    let current: { jobId: number; controller: AbortController } | null = null;

    // Deux chemins mènent à un tour de file, le cadran et l'arrivée d'un
    // fichier : `pending` retient le second plutôt que de le perdre.
    let running = false;
    let pending = false;
    const runGuarded = async (): Promise<void> => {
        if (running) {
            pending = true;
            return;
        }
        running = true;
        try {
            do {
                pending = false;
                while (await runNext()) {
                    // Vide la file avant de rendre la main.
                }
            } while (pending);
        } finally {
            running = false;
        }
    };

    async function runNext(): Promise<boolean> {
        const job = await deps.repo.claimQueued(now());
        if (!job) return false;
        const controller = new AbortController();
        current = { jobId: job.id, controller };
        deps.live.changed(job.workspace_id);
        try {
            await runJob(job, controller.signal);
        } finally {
            current = null;
            deps.live.changed(job.workspace_id);
        }
        return true;
    }

    async function runJob(job: JobRow, signal: AbortSignal): Promise<void> {
        const paths = jobPaths(job.workspace_id, job.id);
        const startedAt = Date.now();
        let lastPublish = 0;
        let lastPersist = 0;
        let lastPermille = -1;
        const onProgress = (permille: number): void => {
            const at = Date.now();
            if (permille === lastPermille || at - lastPublish < PUBLISH_EVERY_MS) return;
            lastPermille = permille;
            lastPublish = at;
            const elapsed = (at - startedAt) / 1000;
            const frame: ConvertProgress = {
                jobId: job.id,
                progress: permille,
                etaSeconds: permille >= 20 ? Math.round((elapsed * (1000 - permille)) / permille) : null
            };
            deps.live.publish(job.workspace_id, CONVERT_PROGRESS_EVENT, frame);
            // La base ne suit que de loin : assez pour qu'un rechargement de page retrouve la barre.
            if (at - lastPersist >= PERSIST_EVERY_MS) {
                lastPersist = at;
                void deps.repo.progress(job.id, permille).catch(() => undefined);
            }
        };

        try {
            const source = sourceOf(job.kind, job.source_format);
            const target = targetOf(job.kind, job.source_format, job.target_format);
            if (!source || !target)
                throw new ConvertFailure('unsupported', 'Cette conversion n’est plus prise en charge.');
            const inputBytes = Number(job.input_bytes);
            // La place a pu partir depuis que le fichier a été accepté.
            if ((await freeBytes()) < inputBytes + env.CONVERT_DISK_FLOOR_BYTES) {
                throw new ConvertFailure('disk_full', 'Le serveur manque de place pour mener cette conversion.');
            }

            const probe = await probeInput(job.kind, source, paths, inputBytes);
            const stored = optionValuesSchema.safeParse(
                typeof job.options === 'string' ? JSON.parse(job.options) : job.options
            );
            await convert({
                source,
                target,
                options: resolveOptions(target.options, stored.success ? stored.data : {}),
                probe,
                paths,
                signal,
                onProgress
            });
            if (signal.aborted) throw new ConvertCanceled();

            const outputBytes = await fileSize(paths.outputPart);
            if (!outputBytes) throw new ConvertFailure('engine_failed', 'La conversion n’a rien produit.');
            // Le renommage rend l'état `done` et la présence du résultat inséparables.
            await fs.rename(paths.outputPart, paths.output);
            await fs.rm(paths.input, { force: true });
            await fs.rm(paths.work, { recursive: true, force: true });

            const finishedAt = now();
            await deps.repo.finish(job.id, outputBytes, finishedAt, finishedAt + env.CONVERT_RESULT_TTL_SECONDS);
            await announce(
                job,
                target.label,
                source.label,
                inputBytes,
                outputBytes,
                Math.round((Date.now() - startedAt) / 1000)
            );
        } catch (e) {
            await removeJobDir(job.workspace_id, job.id);
            if (e instanceof ConvertCanceled) return;
            const failure =
                e instanceof ConvertFailure ? e : new ConvertFailure('engine_failed', 'La conversion a échoué.');
            if (!(e instanceof ConvertFailure))
                deps.logger.error({ err: e, jobId: job.id }, 'convert: travail en échec');
            // Le message d'un outil cite ce qu'il lisait : il est scellé comme le nom du fichier.
            const sealed = await deps.cipherFor(job.workspace_id).encrypt(failure.message);
            await deps.repo.fail(job.id, failure.code, sealed, now());
        }
    }

    /** Prévient à la fin d'un travail assez long pour qu'on ait quitté l'écran. */
    async function announce(
        job: JobRow,
        targetLabel: string,
        sourceLabel: string,
        inputBytes: number,
        outputBytes: number,
        seconds: number
    ): Promise<void> {
        try {
            const settings =
                (await deps.storeFor(job.workspace_id).getJson(SETTINGS_KEY, convertSettingsSchema)) ??
                DEFAULT_SETTINGS;
            if (seconds < settings.notifyAfterSeconds) return;
            const target = targetOf(job.kind, job.source_format, job.target_format);
            const original = await deps.cipherFor(job.workspace_id).tryDecrypt(job.original_name_enc);
            const name = target && original ? outputName(original, target) : 'Votre fichier';
            await deps.deveyeFor(job.workspace_id).notify.send({
                subject: `DevEye : « ${name} » est prêt`,
                body: [
                    `Fichier : ${name}`,
                    `Conversion : ${sourceLabel} vers ${targetLabel}`,
                    `Taille : ${formatBytes(inputBytes)} vers ${formatBytes(outputBytes)}`,
                    `À récupérer dans : ${Math.round(env.CONVERT_RESULT_TTL_SECONDS / 60)} min`
                ].join('\n'),
                payload: { feature: 'convert', jobId: job.id }
            });
        } catch (e) {
            deps.logger.warn({ err: e, jobId: job.id }, 'convert: avis de fin de travail impossible');
        }
    }

    async function upkeep(): Promise<void> {
        const at = now();
        const expired = await deps.repo.expire(at, at - env.CONVERT_UPLOAD_TTL_SECONDS);
        for (const job of expired) await removeJobDir(job.workspaceId, job.id);
        for (const workspaceId of new Set(expired.map((job) => job.workspaceId))) deps.live.changed(workspaceId);
        await sweepStorage(await deps.repo.liveKeys(), deps.logger);
        await deps.repo.purgeOld(at - KEPT_SECONDS);
        await refreshFx();
    }

    async function refreshFx(): Promise<void> {
        try {
            if (!(await refreshRates(deps.repo, seam.fx ?? frankfurter, now(), env.CONVERT_FX_REFRESH_SECONDS))) return;
            for (const workspaceId of await deps.listWorkspaceIds()) deps.live.changed(workspaceId, ['convertRates']);
        } catch (e) {
            deps.logger.warn({ err: e }, 'convert: taux de change illisibles, les derniers connus restent servis');
        }
    }

    const queueTicker = deps.createTicker({ intervalMs: env.CONVERT_TICK_SECONDS * 1000, tick: runGuarded });
    // À part de la file : un transcodage de quarante minutes tient le verrou de
    // son cadran, et aucune purge ne tournerait pendant ce temps.
    const upkeepTicker = deps.createTicker({ intervalMs: env.CONVERT_UPKEEP_SECONDS * 1000, tick: upkeep });

    return {
        async start() {
            await probeEngines(await probeStorage(), deps.logger);
            // Un arrêt brutal ne repasse par aucun `finally` : le ménage se fait ici.
            const requeued = await deps.repo.recoverStale(env.CONVERT_MAX_ATTEMPTS, now());
            if (requeued > 0) deps.logger.info({ requeued }, 'convert: travaux remis en file après un arrêt');
            await sweepStorage(await deps.repo.liveKeys(), deps.logger);

            setQueueWaker(() => {
                void runGuarded().catch((e: unknown) =>
                    deps.logger.error({ err: e }, 'convert: tour de file en échec')
                );
            });
            setJobAborter((jobId) => {
                if (current?.jobId === jobId) current.controller.abort();
            });
            await queueTicker.start();
            await upkeepTicker.start();
            void refreshFx();
        },
        async stop() {
            setQueueWaker(null);
            setJobAborter(null);
            current?.controller.abort();
            await queueTicker.stop();
            await upkeepTicker.stop();
        },
        publicRoutes(app) {
            convertRoutes(app, deps);
        }
    };
}
