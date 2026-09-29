import { composeAlert, createThrottle, formatDuration, webhookBody, type Alert } from '../src/Services/alertCore';
import type { Mailer } from '../src/Services/mailer';
import { statusChannelsSchema, type StatusChannels } from '../src/Services/statusProbeContract';
import { escapeHtml } from '../features/uptime/src/server/statusPage/html';
import type { ComponentChange } from './monitor';
import type { Store } from './store';

/**
 * Prévenir quand DevEye ne le peut plus : par les destinations de sa cible
 * Système, relevées chez lui tant qu'il répond et gardées ici pour quand il ne
 * répond plus. Les webhooks partent d'ici ; les e-mails par le SMTP du serveur,
 * le compte Mail de l'espace étant hors d'atteinte. Une panne et son retour,
 * jamais une maintenance : elle est annoncée.
 */

export const CHANNELS_REFRESH_MS = 10 * 60_000;
const CHANNELS_KEY = 'channels';
const alarmKey = (id: string): string => `alarm:${id}`;

export interface AlertDeps {
    store: Store;
    /** Hors production, rien ne part : une page d'état de dev préviendrait la prod. */
    live: boolean;
    /** L'app surveillée, dite dans chaque alerte. */
    origin: string;
    mailer: Mailer;
    fallbackEmail: string | null;
    fetchChannels(): Promise<unknown>;
    post(url: string, body: Record<string, unknown>): Promise<boolean>;
    log(message: string): void;
    now?: () => number;
}

function titleOf(change: ComponentChange, down: boolean): string {
    const { component } = change;
    if (component.kind === 'app') return down ? 'DevEye est hors service' : 'DevEye est rétabli';
    if (component.kind === 'public')
        return down ? 'Les pages publiques sont hors service' : 'Les pages publiques sont rétablies';
    return down ? `« ${component.label} » est hors service` : `« ${component.label} » est rétabli`;
}

/** Du texte, en HTML inerte : le SMTP du serveur exige les deux. */
function mailHtml(alert: Alert): string {
    return alert.body
        .split('\n\n')
        .map((part) => `<p>${escapeHtml(part).replace(/\n/g, '<br>')}</p>`)
        .join('');
}

export function createAlerts(deps: AlertDeps) {
    const now = deps.now ?? (() => Math.floor(Date.now() / 1000));

    const channels = (): StatusChannels => {
        const raw = deps.store.meta(CHANNELS_KEY);
        const parsed = raw ? statusChannelsSchema.safeParse(JSON.parse(raw)) : null;
        return parsed?.success ? parsed.data : { webhooks: [], emails: [] };
    };

    const deliver = async (alert: Alert): Promise<void> => {
        if (!deps.live) {
            deps.log(`Alerte non envoyée hors production : ${alert.subject}`);
            return;
        }
        const { webhooks, emails } = channels();
        const recipients = new Set(emails);
        if (deps.fallbackEmail) recipients.add(deps.fallbackEmail);
        const jobs = [
            ...webhooks
                .filter((w) => /^https?:\/\//.test(w.url))
                .map((w) => deps.post(w.url, webhookBody(w.kind, alert))),
            ...(deps.mailer.configured
                ? [...recipients].map((to) =>
                      deps.mailer
                          .send({ to, subject: alert.subject, text: alert.body, html: mailHtml(alert) })
                          .then(() => true)
                  )
                : [])
        ];
        if (jobs.length === 0) {
            deps.log(`Aucune destination pour l’alerte : ${alert.subject}`);
            return;
        }
        const results = await Promise.allSettled(jobs);
        const failed = results.filter((r) => r.status === 'rejected' || r.value === false).length;
        if (failed > 0) deps.log(`${failed} envoi(s) refusé(s) sur ${jobs.length} pour : ${alert.subject}`);
    };

    const throttle = createThrottle(
        (held) =>
            void deliver(
                composeAlert(
                    {
                        key: 'held',
                        level: 'error',
                        title: `${held} alerte(s) de la page d’état retenue(s)`,
                        detail: 'Trop d’alertes dans l’heure : le détail est sur la page d’état.'
                    },
                    0,
                    now(),
                    deps.origin
                )
            )
    );

    const send = (key: string, event: Parameters<typeof composeAlert>[0]): void => {
        const verdict = throttle.admit(key, Date.now());
        if (!verdict.send) return;
        void deliver(composeAlert(event, verdict.repeats, now(), deps.origin)).catch((e: unknown) =>
            deps.log(`Échec de l’alerte « ${event.title} » : ${e instanceof Error ? e.message : String(e)}`)
        );
    };

    return {
        /** Une panne propre ouvre l'alarme, tout autre état la referme. Une panne héritée de l'app ne double pas son alerte. */
        onChange(change: ComponentChange): void {
            const { id } = change.component;
            const open = deps.store.meta(alarmKey(id));
            const { next } = change;
            if (next.state === 'down' && !next.inherited) {
                if (open) return;
                deps.store.setMeta(alarmKey(id), String(change.transition.at));
                send(`${id}:down`, {
                    key: `${id}:down`,
                    level: 'critical',
                    title: titleOf(change, true),
                    ...(next.reason ? { detail: next.reason } : {})
                });
                return;
            }
            if (!open || (next.state === 'down' && next.inherited)) return;
            deps.store.setMeta(alarmKey(id), '');
            const lasted = Math.max(0, change.transition.at - Number(open));
            const after = next.state === 'maintenance' ? ', désormais en maintenance' : '';
            send(`${id}:up`, {
                key: `${id}:up`,
                level: 'resolved',
                title: titleOf(change, false),
                detail: `Hors service pendant ${formatDuration(lasted)}${after}.`
            });
        },

        /** Les destinations de la cible Système, relues tant que DevEye répond. */
        async refreshChannels(): Promise<void> {
            try {
                const parsed = statusChannelsSchema.safeParse(await deps.fetchChannels());
                if (parsed.success) deps.store.setMeta(CHANNELS_KEY, JSON.stringify(parsed.data));
            } catch {
                // DevEye ne répond pas : les destinations déjà connues restent.
            }
        }
    };
}
