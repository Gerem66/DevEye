import type { Logger } from 'pino';
import { LOGIN_HISTORY_DAYS } from '@deveye/types';
import type { FeatureService } from '@deveye/types/sdk/server';

import type { Database } from '@/db';

/**
 * La durée promise par la politique de confidentialité (« journaux de
 * connexion et d'accès : douze mois au plus ») : la changer ici, c'est changer
 * ce que dit le site.
 */
export const LOG_RETENTION_DAYS = 365;
/** Après l'expiration ou la révocation d'un jeton de rafraîchissement. */
export const REFRESH_TOKEN_GRACE_DAYS = 30;
/** Après l'expiration d'une invitation d'espace. */
export const INVITATION_GRACE_DAYS = 30;
/**
 * La durée des signalements dans la politique de confidentialité, au bout de
 * laquelle ils sont anonymisés : leur partie technique reste.
 */
export const FEEDBACK_RETENTION_DAYS = 3 * 365;

const DAY_MS = 24 * 3600 * 1000;
/** Par lots : un seul DELETE sur une table de plusieurs millions de lignes la verrouillerait longtemps. */
const BATCH = 5000;

/** L'instant, en secondes, avant lequel une ligne vieille de `days` jours part. */
const cutoffOf = (now: number, days: number): number => Math.floor(now / 1000) - days * 24 * 3600;

/** Enchaîne les lots jusqu'au premier incomplet, et dit combien de lignes sont parties. */
async function inBatches(purge: (batch: number) => Promise<number>): Promise<number> {
    let total = 0;
    for (;;) {
        const removed = await purge(BATCH);
        total += removed;
        if (removed < BATCH) return total;
    }
}

/** Supprime le journal d'audit au-delà de la durée de conservation, et dit combien de lignes sont parties. */
export function purgeExpiredLogs(db: Pick<Database, 'logs'>, now: number): Promise<number> {
    const cutoff = cutoffOf(now, LOG_RETENTION_DAYS);
    return inBatches((batch) => db.logs.purgeBefore(cutoff, batch));
}

/** Supprime l'historique des connexions au-delà de sa durée de conservation, et dit combien de lignes sont parties. */
export function purgeExpiredLoginHistory(db: Pick<Database, 'loginHistory'>, now: number): Promise<number> {
    const cutoff = cutoffOf(now, LOGIN_HISTORY_DAYS);
    return inBatches((batch) => db.loginHistory.purgeBefore(cutoff, batch));
}

export function purgeExpiredRefreshTokens(db: Pick<Database, 'refreshTokens'>, now: number): Promise<number> {
    const cutoff = cutoffOf(now, REFRESH_TOKEN_GRACE_DAYS);
    return inBatches((batch) => db.refreshTokens.purgeBefore(cutoff, batch));
}

export function purgeExpiredInvitations(db: Pick<Database, 'workspaceInvitations'>, now: number): Promise<number> {
    const cutoff = cutoffOf(now, INVITATION_GRACE_DAYS);
    return inBatches((batch) => db.workspaceInvitations.purgeBefore(cutoff, batch));
}

export function anonymizeExpiredFeedback(db: Pick<Database, 'feedback'>, now: number): Promise<number> {
    const cutoff = cutoffOf(now, FEEDBACK_RETENTION_DAYS);
    return inBatches((batch) => db.feedback.anonymizeBefore(cutoff, Math.floor(now / 1000), batch));
}

const PURGES: readonly {
    table: string;
    days: number;
    purge: (db: Database, now: number) => Promise<number>;
    /** Les lignes restent, privées de ce qui désigne une personne. */
    anonymizes?: true;
}[] = [
    { table: 'logs', days: LOG_RETENTION_DAYS, purge: purgeExpiredLogs },
    { table: 'login_history', days: LOGIN_HISTORY_DAYS, purge: purgeExpiredLoginHistory },
    { table: 'refresh_tokens', days: REFRESH_TOKEN_GRACE_DAYS, purge: purgeExpiredRefreshTokens },
    { table: 'workspace_invitations', days: INVITATION_GRACE_DAYS, purge: purgeExpiredInvitations },
    { table: 'feedback', days: FEEDBACK_RETENTION_DAYS, purge: anonymizeExpiredFeedback, anonymizes: true }
];

/** Une passe au démarrage, puis une par jour. */
export function createLogRetention(host: { db: Database; logger: Logger }): FeatureService {
    let timer: ReturnType<typeof setInterval> | null = null;
    let running = false;

    const run = async (): Promise<void> => {
        if (running) return;
        running = true;
        try {
            // Une table en échec ne prive pas les suivantes de leur purge.
            for (const { table, days, purge, anonymizes } of PURGES) {
                try {
                    const removed = await purge(host.db, Date.now());
                    if (removed > 0) {
                        host.logger.info(
                            { table, rows: removed, days },
                            anonymizes ? 'Expired rows anonymized' : 'Expired rows purged'
                        );
                    }
                } catch (e) {
                    host.logger.error({ err: e, table }, 'Retention purge failed');
                }
            }
        } finally {
            running = false;
        }
    };

    return {
        start: () => {
            if (timer) return;
            void run();
            timer = setInterval(() => void run(), DAY_MS);
            timer.unref();
        },
        stop: () => {
            if (timer) clearInterval(timer);
            timer = null;
        }
    };
}
