import type { NotificationChannelKind } from '@deveye/types';

import type { DiscordMessage } from '@/Services/discord';
import { COLOR_DANGER, COLOR_INFO, COLOR_SUCCESS, block, footer } from '@/Services/notices/shared';

/**
 * La forme et la mise en page des alertes, sans base ni réseau : partagée par
 * le serveur et par la page d'état, qui tourne dans un autre conteneur et ne
 * doit rien charger de l'app. Tout import ajouté ici reste pur.
 */

/** Ce qu'une alerte porte, indépendamment du canal qui la transporte. */
export interface Alert {
    subject: string;
    body: string;
    /**
     * Champs structurés du webhook, en plus de `content`/`text`. Permet à un
     * point d'entrée maison de filtrer sans analyser du texte.
     */
    payload: Record<string, unknown>;
    /** La mise en page Discord de cette alerte, quand la feature en a une ; sinon le texte. */
    embeds?: DiscordMessage['embeds'];
}

/**
 * Tronqué sous la limite stricte de 2000 caractères de Discord, qui rejette le
 * message entier au-delà plutôt que de le couper.
 */
export const WEBHOOK_TEXT_MAX = 1900;

/**
 * La charge utile envoyée au webhook, décidée par le type du canal. Sur un
 * canal `webhook`, trois têtes : `content` pour Discord, `text` pour Slack, les
 * champs structurés pour un point d'entrée maison. Sur un canal `discord`
 * fourni d'embeds, `content` est retiré : le garder afficherait l'alerte deux fois.
 */
export function webhookBody(kind: NotificationChannelKind, alert: Alert): Record<string, unknown> {
    const text = alert.body.slice(0, WEBHOOK_TEXT_MAX);
    if (kind === 'discord' && alert.embeds && alert.embeds.length > 0) {
        return { embeds: alert.embeds, ...alert.payload };
    }
    return { content: text, text, ...alert.payload };
}

/** Une alerte telle qu'un canal e-mail l'envoie : du texte seul. */
export function alertMail(alert: Alert): { subject: string; text: string } {
    return { subject: alert.subject, text: alert.body };
}

/** Date et heure dans le corps d'une alerte, en français, les mêmes pour tous les émetteurs. */
export function formatMoment(epochSeconds: number): string {
    return new Date(epochSeconds * 1000).toLocaleString('fr-FR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
}

/** « 2 h 5 min », « 45 s » : une durée lisible dans un corps d'alerte. */
export function formatDuration(seconds: number): string {
    if (seconds < 60) return `${seconds} s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} h ${minutes % 60} min`;
    return `${Math.floor(hours / 24)} j ${hours % 24} h`;
}

/** `resolved` annonce un retour à la normale. */
export type SystemAlertLevel = 'info' | 'resolved' | 'error' | 'critical';

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

const LEVEL_COLOR: Record<SystemAlertLevel, number> = {
    info: COLOR_INFO,
    resolved: COLOR_SUCCESS,
    error: COLOR_DANGER,
    critical: COLOR_DANGER
};

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
                color: LEVEL_COLOR[event.level],
                timestamp: new Date(at * 1000).toISOString(),
                footer: footer(origin)
            }
        ]
    };
}
