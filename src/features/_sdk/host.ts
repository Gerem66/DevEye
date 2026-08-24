import type { MonitorHub } from '@/agent/hub';

/**
 * Le point d'attache du hub agents pour l'assemblage SDK.
 *
 * La façade `deveye.agents` d'un contexte de requête a besoin du hub (portée
 * flotte), que le `FeatureContext` natif ne transporte pas : lui ne connaît
 * que `monitor`, le transport du socket appelant. Le hub est unique par
 * processus et vit dans `buildApp` ; il se dépose ici une fois, avant
 * l'enregistrement des WS, et l'assemblage le lit à la demande.
 */
let HUB: MonitorHub | null = null;

export function setSdkHub(hub: MonitorHub): void {
    HUB = hub;
}

export function sdkHub(): MonitorHub {
    if (!HUB) throw new Error('SDK: hub agents non attaché (setSdkHub manquant au boot)');
    return HUB;
}
