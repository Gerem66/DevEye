import type { AdminPending } from '@deveye/types';

import type { Database } from '@/db';
import type { LiveHub } from '@/live/hub';

/** Un module qui compte ce qui attend une décision humaine, onglet par onglet. */
export interface PendingSource {
    featureId: string;
    /** Les onglets de son manifest : un compte rendu sous un autre id ne s'allume pas. */
    tabs: readonly { id: string; moderation?: true }[];
    read(): Promise<Readonly<Record<string, number>>>;
}

export interface AdminPendingDeps {
    db: Pick<Database, 'users' | 'feedback'>;
    live: Pick<LiveHub, 'userChanged'>;
    logger: { error(obj: object, msg: string): void };
    sources: readonly PendingSource[];
    feedbackEnabled: boolean;
    /** `maintenance.refuses` : ce qu'un compte ne peut pas ouvrir ne s'allume pas pour lui. */
    refuses(featureId: string, isAdmin: boolean): boolean;
}

export interface AdminPendingService {
    /** Ce que ce compte peut traiter : les onglets de modération pour un modérateur, tout pour un administrateur. */
    forViewer(isAdmin: boolean): Promise<AdminPending>;
    /** Un compteur a pu bouger : les comptes qui modèrent relisent leurs badges, une fois par rafale. */
    changed(): void;
    close(): void;
}

/** Une file traitée d'affilée ne pousse qu'une trame. */
export const PENDING_COALESCE_MS = 1_000;
/** Tous les comptes qui modèrent relisent sur la même trame : un relevé les sert tous. */
const MEMO_MS = 5_000;

interface Reading {
    at: number;
    feedback: number;
    modules: { source: PendingSource; counts: Readonly<Record<string, number>> }[];
}

export function createAdminPending(deps: AdminPendingDeps): AdminPendingService {
    let memo: Reading | null = null;
    let running: Promise<Reading> | null = null;
    // Un relevé commencé avant un changement ne doit pas servir de mémoire après lui.
    let generation = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    // Un module en panne compte pour rien : il n'éteint pas les badges des autres.
    const readSource = async (source: PendingSource): Promise<Readonly<Record<string, number>>> => {
        try {
            return await source.read();
        } catch (err) {
            deps.logger.error({ err, module: source.featureId }, 'Compte des éléments à traiter en échec');
            return {};
        }
    };

    const collect = async (): Promise<Reading> => {
        const [feedback, counts] = await Promise.all([
            deps.feedbackEnabled ? deps.db.feedback.countPending() : Promise.resolve(0),
            Promise.all(deps.sources.map(readSource))
        ]);
        return {
            at: Date.now(),
            feedback,
            modules: deps.sources.map((source, i) => ({ source, counts: counts[i] }))
        };
    };

    const reading = (): Promise<Reading> => {
        if (memo && Date.now() - memo.at < MEMO_MS) return Promise.resolve(memo);
        if (running) return running;
        const gen = generation;
        const run = collect()
            .then((r) => {
                if (gen === generation) memo = r;
                return r;
            })
            .finally(() => {
                if (running === run) running = null;
            });
        running = run;
        return run;
    };

    const push = async (): Promise<void> => {
        try {
            for (const { id, personalWorkspaceId } of await deps.db.users.listModeratorIds()) {
                deps.live.userChanged(id, personalWorkspaceId, ['pending'], null);
            }
        } catch (err) {
            deps.logger.error({ err }, 'Badges de modération non poussés');
        }
    };

    return {
        async forViewer(isAdmin) {
            const { feedback, modules } = await reading();
            const features: AdminPending['features'] = {};
            for (const { source, counts } of modules) {
                if (deps.refuses(source.featureId, isAdmin)) continue;
                const tabs: Record<string, number> = {};
                for (const tab of source.tabs) {
                    if (!isAdmin && !tab.moderation) continue;
                    const n = Math.floor(Number(counts[tab.id] ?? 0));
                    if (Number.isFinite(n) && n > 0) tabs[tab.id] = n;
                }
                if (Object.keys(tabs).length > 0) features[source.featureId] = tabs;
            }
            return { feedback, features };
        },
        changed() {
            generation += 1;
            memo = null;
            running = null;
            if (timer) return;
            timer = setTimeout(() => {
                timer = null;
                void push();
            }, PENDING_COALESCE_MS);
            timer.unref();
        },
        close() {
            if (timer) clearTimeout(timer);
            timer = null;
        }
    };
}

let service: AdminPendingService | null = null;

/** Le service du processus, posé au boot (`app.ts`). */
export const adminPending = {
    init(deps: AdminPendingDeps): void {
        service = createAdminPending(deps);
    },
    forViewer(isAdmin: boolean): Promise<AdminPending> {
        if (!service) throw new Error('adminPending : init() manquant au boot');
        return service.forViewer(isAdmin);
    },
    /** Sans `init` (un test, un script), personne n'écoute : l'appel ne fait rien. */
    changed(): void {
        service?.changed();
    },
    close(): void {
        service?.close();
        service = null;
    }
};
