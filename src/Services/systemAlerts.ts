import type { Logger } from 'pino';
import { SYSTEM_NOTIFICATION_TARGET } from '@deveye/types';

import type { Database } from '@/db';
import type Encryption from '@/Services/Encryption';
import { createOpenCipher } from '@/Services/SecureStore';
import { COLOR_DANGER, COLOR_INFO, block, footer } from '@/Services/notices/shared';
import { deliver, formatMoment, resolveRoute, type Alert } from '@/Services/notifications';
import { env } from '@/Utils/Env';

/**
 * Les alertes de l'instance elle-même (erreurs serveur, plantages,
 * redémarrages), livrées par les canaux de la cible `system` que les admins
 * règlent dans un espace qu'ils possèdent. Seuls les défauts du système y
 * passent, jamais une erreur d'utilisateur : un webhook cassé ou une boîte
 * injoignable regardent leur propriétaire.
 */

export type SystemAlertLevel = 'info' | 'error' | 'critical';

export interface SystemAlertEvent {
    /** Regroupe les répétitions : une même clé ne repart qu'après `KEY_WINDOW_MS`. */
    key: string;
    level: SystemAlertLevel;
    title: string;
    /** Message, commande, extrait de pile : rendu en bloc de code. */
    detail?: string;
}

export const KEY_WINDOW_MS = 10 * 60_000;
export const HOUR_MS = 3600_000;
export const HOURLY_MAX = 20;

type Verdict = { send: true; repeats: number } | { send: false };

/**
 * L'anti-rafale : une alerte par clé et par fenêtre, et un plafond horaire
 * au-delà duquel les alertes sont retenues puis résumées en une seule. Les
 * répétitions d'une clé sont comptées et annoncées avec son alerte suivante.
 */
export function createThrottle(onHeld: (held: number, since: number) => void) {
    const keys = new Map<string, { last: number; repeats: number }>();
    let windowStart = -Infinity;
    let sent = 0;
    let held = 0;
    let summary: ReturnType<typeof setTimeout> | null = null;

    return {
        admit(key: string, now: number): Verdict {
            if (now - windowStart >= HOUR_MS) {
                windowStart = now;
                sent = 0;
            }
            const entry = keys.get(key);
            if (entry && now - entry.last < KEY_WINDOW_MS) {
                entry.repeats++;
                return { send: false };
            }
            if (sent >= HOURLY_MAX) {
                held++;
                if (!summary) {
                    const since = windowStart;
                    summary = setTimeout(
                        () => {
                            summary = null;
                            const count = held;
                            held = 0;
                            if (count > 0) onHeld(count, since);
                        },
                        Math.max(0, windowStart + HOUR_MS - now)
                    );
                    summary.unref();
                }
                return { send: false };
            }
            sent++;
            const repeats = entry?.repeats ?? 0;
            keys.set(key, { last: now, repeats: 0 });
            return { send: true, repeats };
        }
    };
}

/** L'alerte telle que tous les canaux la reçoivent. */
export function composeAlert(event: SystemAlertEvent, repeats: number, at: number, origin: string): Alert {
    const lines = [event.title];
    if (event.detail) lines.push('', event.detail);
    if (repeats > 0) lines.push('', `Répétée ${repeats} fois depuis l’alerte précédente.`);
    lines.push('', `Instance : ${origin}`, `Le ${formatMoment(at)}`);
    const description = [
        event.detail ? block(event.detail) : '',
        repeats > 0 ? `Répétée ${repeats} fois depuis l’alerte précédente.` : ''
    ]
        .filter(Boolean)
        .join('\n');
    return {
        subject: `[DevEye] ${event.title}`,
        body: lines.join('\n'),
        payload: { event: 'system_alert', key: event.key, level: event.level, repeats, origin, at },
        embeds: [
            {
                title: event.title,
                ...(description ? { description } : {}),
                color: event.level === 'info' ? COLOR_INFO : COLOR_DANGER,
                timestamp: new Date(at * 1000).toISOString(),
                footer: footer(origin)
            }
        ]
    };
}

export interface SystemAlertsDeps {
    db: Database;
    crypt: Encryption;
    logger: Logger;
    /** Hors production, rien ne part : un serveur de dev sur la base partagée préviendrait la prod. */
    live: boolean;
}

export function createSystemAlerts(deps: SystemAlertsDeps, now: () => number = Date.now) {
    const inflight = new Set<Promise<void>>();

    const send = (alert: Alert): void => {
        if (!deps.live) {
            deps.logger.info({ subject: alert.subject }, 'System alert not sent outside production');
            return;
        }
        const job = (async () => {
            try {
                const workspaces = await deps.db.notificationChannels.systemRouteWorkspaces();
                await Promise.all(
                    workspaces.map(async (workspaceId) => {
                        const cipher = createOpenCipher(deps.db, deps.crypt, workspaceId);
                        const channels = await resolveRoute(deps.db, cipher, workspaceId, SYSTEM_NOTIFICATION_TARGET);
                        await deliver(channels, alert, deps.logger);
                    })
                );
            } catch (e) {
                deps.logger.warn({ err: e }, 'System alert delivery failed');
            }
        })();
        inflight.add(job);
        void job.finally(() => inflight.delete(job));
    };

    const origin = env.PUBLIC_ORIGIN.replace(/\/+$/, '');
    const throttle = createThrottle((held, since) =>
        send(
            composeAlert(
                {
                    key: 'held',
                    level: 'error',
                    title: `${held} alerte(s) retenue(s)`,
                    detail: `Plus de ${HOURLY_MAX} alertes dans l’heure depuis le ${formatMoment(Math.floor(since / 1000))} : les suivantes ont été retenues. Le détail est dans les journaux du serveur.`
                },
                0,
                Math.floor(now() / 1000),
                origin
            )
        )
    );

    return {
        /** Ne lève jamais, n'attend rien : l'appelant a déjà journalisé l'erreur. */
        report(event: SystemAlertEvent): void {
            const t = now();
            const verdict = throttle.admit(event.key, t);
            if (!verdict.send) return;
            send(composeAlert(event, verdict.repeats, Math.floor(t / 1000), origin));
        },
        /** Laisse partir les envois en cours, `ms` au plus : un plantage n'attend pas indéfiniment le réseau. */
        async flush(ms: number): Promise<void> {
            if (inflight.size === 0) return;
            await Promise.race([
                Promise.allSettled([...inflight]),
                new Promise((resolve) => setTimeout(resolve, ms).unref())
            ]);
        },
        /** Au boot : une cible sans route est un silence qu'on ne découvrirait qu'au premier incident. */
        async warnIfUnrouted(): Promise<void> {
            if (!deps.live) return;
            try {
                const workspaces = await deps.db.notificationChannels.systemRouteWorkspaces();
                if (workspaces.length === 0) {
                    deps.logger.warn('No system alert channel: server errors and crashes will notify nobody');
                }
            } catch (e) {
                deps.logger.warn({ err: e }, 'System alert routes unreadable');
            }
        }
    };
}

type SystemAlerts = ReturnType<typeof createSystemAlerts>;

let instance: SystemAlerts | null = null;

/**
 * Le point d'entrée des sites d'appel (gestionnaire d'erreurs HTTP, dispatcheur
 * WS, services des modules) : sans dépendance à passer. Avant `init`, rien ne
 * part, l'erreur reste dans le journal.
 */
export const systemAlerts = {
    init(deps: SystemAlertsDeps): void {
        instance = createSystemAlerts(deps);
    },
    report(event: SystemAlertEvent): void {
        instance?.report(event);
    },
    flush(ms: number): Promise<void> {
        return instance?.flush(ms) ?? Promise.resolve();
    },
    warnIfUnrouted(): Promise<void> {
        return instance?.warnIfUnrouted() ?? Promise.resolve();
    }
};

/** Le détail d'une erreur pour une alerte : son message et le haut de sa pile. */
export function describeError(e: unknown): string {
    if (e instanceof Error) {
        const stack = e.stack?.split('\n').slice(1, 6).join('\n') ?? '';
        return stack ? `${e.name}: ${e.message}\n${stack}` : `${e.name}: ${e.message}`;
    }
    return String(e);
}
