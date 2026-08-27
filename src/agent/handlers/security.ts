import { AGENT_AUTH_EVENTS, AGENT_INTEGRITY } from '@deveye/types';

import { ack, type AgentSession, type PayloadOf } from './session';

/**
 * Les deux relevés de Sentinelle : le manifeste des surfaces de persistance et
 * la fenêtre d'issues d'authentification.
 *
 * ## Ces handlers n'évaluent rien
 *
 * Ils tendent le relevé aux hooks des modules installés, et c'est le moteur de
 * Sentinelle qui l'empile dans sa file et l'évalue à son tour de boucle : le
 * chemin d'ingestion doit rester court, et un manifeste de deux mille entrées
 * n'a rien à faire sur la même pile d'appels que la socket de l'agent.
 *
 * ## Rien n'est stocké brut
 *
 * Le manifeste ne va **pas** en base. Ce qu'on garde, c'est le résultat du diff
 * (dans `device_baseline`) et les constats qu'il produit. Garder les manifestes
 * coûterait des centaines de mégaoctets par mois pour répondre à une question
 * que le diff a déjà tranchée. La fenêtre d'authentification suit la même
 * règle : on garde ses conclusions, pas ses lignes.
 *
 * ## La garde de l'app, et celle du module
 *
 * L'app ne garde que `status === 'active'` : c'est l'invariant 8 de Monitoring,
 * rien ne se persiste (ni ne se tend aux modules) pour un appareil qui n'est
 * pas approuvé. Qu'un appareil soit surveillé, ou que sa sonde
 * d'authentification soit éteinte, c'est Sentinelle qui le sait depuis son
 * rapatriement, et son hook jette ce qu'elle n'a pas demandé (un agent qui
 * ignorerait sa config ne doit pas pouvoir imposer la lecture de journaux
 * qu'on a refusée).
 */

/**
 * True (et accuse réception) quand l'appareil n'a pas à être analysé.
 *
 * On accuse quand même : un agent qui n'obtient pas d'accusé réémet, et une
 * machine tout juste révoquée renverrait son manifeste en boucle. Le silence
 * n'est pas un refus lisible.
 */
async function gated(s: AgentSession): Promise<boolean> {
    // Le statut de la session est un instantané pris à la connexion, et un agent
    // reste connecté des semaines : on relit la ligne plutôt que de refuser sur
    // une donnée périmée (même raison que `gated` dans `telemetry.ts`).
    const fresh = await s.db.devices.findById(s.device.id);
    if (fresh) s.device = fresh;

    if (s.device.status !== 'active') {
        s.logger.debug({ status: s.device.status }, 'Sentinel probe dropped: device not active');
        ack(s, 0);
        return true;
    }
    return false;
}

export async function handleIntegrity(s: AgentSession, payload: PayloadOf<typeof AGENT_INTEGRITY>): Promise<void> {
    if (await gated(s)) return;
    const { integrity } = payload;
    s.hooks.onIntegrity(s.device.id, integrity);
    ack(s, integrity.entries.length);
}

export async function handleAuthEvents(s: AgentSession, payload: PayloadOf<typeof AGENT_AUTH_EVENTS>): Promise<void> {
    if (await gated(s)) return;
    const { auth } = payload;
    s.hooks.onAuthEvents(s.device.id, auth);
    ack(s, auth.topSources.length + auth.logins.length);
}
