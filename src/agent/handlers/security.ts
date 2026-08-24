import { AGENT_AUTH_EVENTS, AGENT_INTEGRITY } from '@deveye/types';

import { ack, type AgentSession, type PayloadOf } from './session';

/**
 * Les deux relevés de Sentinelle : le manifeste des surfaces de persistance et
 * la fenêtre d'issues d'authentification.
 *
 * ## Ces handlers n'évaluent rien
 *
 * Ils empilent dans la file du moteur, qui évalue à son tour de boucle. C'est
 * l'invariant de `SecurityMonitor` : le chemin d'ingestion doit rester court,
 * et un manifeste de deux mille entrées n'a rien à faire sur la même pile
 * d'appels que la socket de l'agent.
 *
 * ## Rien n'est stocké brut
 *
 * Le manifeste ne va **pas** en base. Ce qu'on garde, c'est le résultat du diff
 * (dans `device_baseline`) et les constats qu'il produit. Garder les manifestes
 * coûterait des centaines de mégaoctets par mois pour répondre à une question
 * que le diff a déjà tranchée. La fenêtre d'authentification suit la même
 * règle : on garde ses conclusions, pas ses lignes.
 *
 * ## Même garde que la télémétrie
 *
 * `sentinel_enabled` **et** `status === 'active'`. Le premier parce qu'un
 * appareil non surveillé ne doit pas voir ses journaux lus, le second parce que
 * c'est l'invariant 8 de Monitoring : rien ne se persiste pour un appareil qui
 * n'est pas approuvé.
 */

/**
 * True (et accuse réception) quand l'appareil n'a pas à être analysé.
 *
 * On accuse quand même : un agent qui n'obtient pas d'accusé réémet, et une
 * machine dont Sentinelle vient d'être éteinte renverrait son manifeste en
 * boucle. Le silence n'est pas un refus lisible.
 */
async function gated(s: AgentSession): Promise<boolean> {
    // Le statut de la session est un instantané pris à la connexion, et un agent
    // reste connecté des semaines : on relit la ligne plutôt que de refuser sur
    // une donnée périmée (même raison que `gated` dans `telemetry.ts`).
    const fresh = await s.db.devices.findById(s.device.id);
    if (fresh) s.device = fresh;

    if (s.device.status !== 'active' || s.device.sentinel_enabled !== 1) {
        s.logger.debug(
            { status: s.device.status, sentinel: s.device.sentinel_enabled },
            'Sentinel probe dropped: device not watched'
        );
        ack(s, 0);
        return true;
    }
    return false;
}

export async function handleIntegrity(s: AgentSession, payload: PayloadOf<typeof AGENT_INTEGRITY>): Promise<void> {
    if (await gated(s)) return;
    const { integrity } = payload;
    s.sentinel?.enqueueIntegrity(s.device.id, integrity);
    if (integrity.truncated) {
        // Un manifeste tronqué reste exploitable — le moteur s'interdit alors
        // seulement de conclure à des suppressions — mais il mérite une trace :
        // c'est le signe qu'une surface a grossi au-delà de ce qu'on prévoyait.
        s.logger.warn(
            { entries: integrity.entries.length },
            'Sentinel: persistence manifest truncated (removals will not be reported)'
        );
    }
    ack(s, integrity.entries.length);
}

export async function handleAuthEvents(s: AgentSession, payload: PayloadOf<typeof AGENT_AUTH_EVENTS>): Promise<void> {
    if (await gated(s)) return;
    const { auth } = payload;
    if (s.device.sentinel_auth_events !== 1) {
        // La sonde a son propre interrupteur : un agent qui l'ignorerait ne doit
        // pas pouvoir imposer la lecture de journaux qu'on a refusée.
        s.logger.warn('Sentinel: auth window received while auth probing is disabled — dropped');
        ack(s, 0);
        return;
    }
    s.sentinel?.enqueueAuth(s.device.id, auth);
    ack(s, auth.topSources.length + auth.logins.length);
}
