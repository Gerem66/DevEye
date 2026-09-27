import type { Logger } from 'pino';
import {
    debugRunSchema,
    type DebugBenchReport,
    type DebugE2eReport,
    type DebugRun,
    type DebugRunKind
} from '@deveye/types';

import type { Database } from '@/db';
import type { DebugRunRow, DebugRunStatus } from '@/db/repos/debug';
import { FeatureError } from '@/features/_define';

export type RunReport = DebugE2eReport | DebugBenchReport;

export interface Launcher {
    id: number;
    username: string;
}

export interface RunContext<R extends RunReport> {
    runId: number;
    signal: AbortSignal;
    /** Le rapport vivant : l'essai le remplit en place, la page le relit tel quel. */
    report: R;
}

/** L'essai a-t-il réussi : `false` pour un échec, sans lever. */
export type RunExec<R extends RunReport> = (ctx: RunContext<R>) => Promise<boolean>;

interface ActiveRun {
    id: number;
    kind: DebugRunKind;
    report: RunReport;
    launchedBy: Launcher;
    startedAt: number;
    controller: AbortController;
    done: Promise<void>;
}

/** L'historique gardé, par origine et par sorte. */
const KEEP = 100;

const reportSchema = debugRunSchema.shape.report;

function fromRow(row: DebugRunRow): DebugRun | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(row.report);
    } catch {
        return null;
    }
    const report = reportSchema.safeParse(parsed);
    if (!report.success) return null;
    return {
        id: row.id,
        status: row.status,
        startedAt: row.started,
        finishedAt: row.finished,
        launchedBy: row.launchedBy,
        report: report.data
    };
}

export interface RunRegistryDeps {
    db: Pick<Database, 'debug'>;
    origin: string;
    logger: Pick<Logger, 'error' | 'warn'>;
    now?: () => number;
}

/**
 * Un seul essai à la fois sur ce serveur, bout en bout et mesures confondus :
 * deux essais mêlés fausseraient les chiffres de l'un et les balayages de
 * l'autre. L'essai tourne hors de la commande qui le lance, et son rapport
 * s'écrit en base à la fin, quoi qu'il arrive.
 */
export function createRunRegistry({ db, origin, logger, now = Date.now }: RunRegistryDeps) {
    let active: ActiveRun | null = null;
    // Pris aussi par un balayage, qui n'est pas un essai mais ne doit pas en croiser un.
    let locked = false;

    const busy = (): FeatureError => {
        if (!active)
            return new FeatureError('conflict', 'Un ménage des essais est en cours : réessayez dans un instant.');
        const at = new Date(active.startedAt).toLocaleTimeString('fr-FR', {
            hour: '2-digit',
            minute: '2-digit',
            timeZone: 'Europe/Paris'
        });
        return new FeatureError(
            'conflict',
            `Un essai est déjà en cours, lancé par ${active.launchedBy.username} à ${at}.`
        );
    };

    const snapshot = (run: ActiveRun): DebugRun => ({
        id: run.id,
        status: 'running',
        startedAt: run.startedAt,
        finishedAt: null,
        launchedBy: run.launchedBy,
        report: run.report
    });

    return {
        active(): { id: number; kind: DebugRunKind } | null {
            return active && { id: active.id, kind: active.kind };
        },

        async start<R extends RunReport>(launcher: Launcher, report: R, exec: RunExec<R>): Promise<number> {
            if (active || locked) throw busy();
            locked = true;
            const startedAt = now();
            let id: number;
            try {
                id = await db.debug.insertRun({
                    origin,
                    kind: report.kind,
                    started: startedAt,
                    userId: launcher.id,
                    report: JSON.stringify(report)
                });
            } catch (e) {
                locked = false;
                throw e;
            }
            const controller = new AbortController();
            const run: ActiveRun = {
                id,
                kind: report.kind,
                report,
                launchedBy: launcher,
                startedAt,
                controller,
                done: Promise.resolve()
            };
            active = run;
            run.done = (async () => {
                let status: DebugRunStatus = 'failed';
                try {
                    const passed = await exec({ runId: id, signal: controller.signal, report });
                    status = controller.signal.aborted ? 'aborted' : passed ? 'passed' : 'failed';
                } catch (e) {
                    logger.error({ err: e, runId: id }, 'Essai interrompu par une erreur');
                    status = controller.signal.aborted ? 'aborted' : 'failed';
                } finally {
                    try {
                        await db.debug.finishRun(id, { status, finished: now(), report: JSON.stringify(report) });
                        await db.debug.prune(origin, report.kind, KEEP);
                    } catch (e) {
                        logger.error({ err: e, runId: id }, 'Rapport d’essai non enregistré');
                    }
                    active = null;
                    locked = false;
                }
            })();
            return id;
        },

        async get(id: number): Promise<DebugRun | null> {
            if (active?.id === id) return snapshot(active);
            const row = await db.debug.getRun(id, origin);
            return row ? fromRow(row) : null;
        },

        async list(kind: DebugRunKind, limit: number): Promise<DebugRun[]> {
            const rows = await db.debug.listRuns(origin, kind, limit);
            return rows
                .map((row) => (active?.id === row.id ? snapshot(active) : fromRow(row)))
                .filter((run): run is DebugRun => run !== null);
        },

        /** Arrête l'essai ; son ménage a lieu quand même. `false` s'il n'est plus en cours. */
        abort(id: number): boolean {
            if (active?.id !== id) return false;
            active.controller.abort();
            return true;
        },

        /** Un balayage, jamais pendant un essai ni pendant un autre balayage. */
        async withLock<T>(fn: () => Promise<T>): Promise<T> {
            if (active || locked) throw busy();
            locked = true;
            try {
                return await fn();
            } finally {
                locked = false;
            }
        },

        /** Au démarrage : ce qu'un arrêt a interrompu n'est plus en cours. */
        async recover(): Promise<void> {
            const n = await db.debug.abortStale(origin, now());
            if (n > 0) logger.warn({ runs: n }, 'Essais interrompus par un arrêt du serveur');
        },

        /** À l'arrêt : l'essai en cours s'interrompt et fait son ménage avant de rendre la main. */
        async shutdown(): Promise<void> {
            if (!active) return;
            active.controller.abort();
            await active.done;
        }
    };
}

export type RunRegistry = ReturnType<typeof createRunRegistry>;
