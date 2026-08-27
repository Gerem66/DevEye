import type { MonitorHub } from '@/agent/hub';
import { deviceAgentConfig } from '@/agent/mappers';
import type { Database } from '@/db';

/**
 * Le point d'attache de l'hôte pour l'assemblage SDK : le hub agents et la
 * base, déposés une fois au boot.
 *
 * La façade `deveye.agents` d'un contexte de requête a besoin du hub (portée
 * flotte), que le `FeatureContext` natif ne transporte pas : lui ne connaît
 * que `monitor`, le transport du socket appelant. Le hub est unique par
 * processus et vit dans `buildApp` ; il se dépose ici une fois, avant
 * l'enregistrement des WS, et l'assemblage le lit à la demande. La base sert
 * à recomposer la config de collecte d'un appareil (`pushAgentConfig`).
 */
let HUB: MonitorHub | null = null;
let DB: Database | null = null;

export function setSdkHost(hub: MonitorHub, db: Database): void {
    HUB = hub;
    DB = db;
}

export function sdkHub(): MonitorHub {
    if (!HUB) throw new Error('SDK: hub agents non attaché (setSdkHost manquant au boot)');
    return HUB;
}

function sdkDb(): Database {
    if (!DB) throw new Error('SDK: base non attachée (setSdkHost manquant au boot)');
    return DB;
}

/**
 * Pousse à l'agent la config de collecte de son appareil, recomposée par l'app
 * depuis la ligne appareil (et ce que les modules y contribuent). Faux quand
 * l'agent est hors ligne : il recevra la config à sa prochaine connexion, le
 * chemin de `agent/ws.ts` la rejoue à chaque poignée de main.
 */
export async function pushAgentConfig(deviceId: string): Promise<boolean> {
    const hub = sdkHub();
    if (!hub.isOnline(deviceId)) return false;
    const row = await sdkDb().devices.findById(deviceId);
    if (!row) return false;
    return hub.pushConfig(deviceId, deviceAgentConfig(row));
}
