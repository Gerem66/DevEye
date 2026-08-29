import crypto from 'node:crypto';
import type Encryption from '@/Services/Encryption';
import type { SdkServerKeys } from '@deveye/types/sdk/server';
import type { MonitorHub } from '@/agent/hub';
import { agentConfigFor } from '@/agent/config';
import type { Database } from '@/db';

/**
 * Le point d'attache de l'hôte pour l'assemblage SDK : le hub agents (portée
 * flotte, que le `FeatureContext` natif ne transporte pas) et la base, déposés
 * une fois au boot, avant l'enregistrement des WS.
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
 * Pousse à l'agent la config de collecte de son appareil (`agentConfigFor`).
 * Faux quand l'agent est hors ligne : il la recevra à sa prochaine connexion.
 * Le cycle d'import avec `agent/config.ts` est sans effet : rien n'y est évalué
 * au chargement.
 */
export async function pushAgentConfig(deviceId: string): Promise<boolean> {
    const hub = sdkHub();
    if (!hub.isOnline(deviceId)) return false;
    const row = await sdkDb().devices.findById(deviceId);
    if (!row) return false;
    return hub.pushConfig(deviceId, await agentConfigFor(row));
}

/**
 * Les dérivations de la clé serveur offertes à un module : sceller/ouvrir des
 * octets, et l'HKDF que `scripts/restore-backup.mjs` refait sans DevEye. La
 * clé elle-même ne sort jamais.
 */
export function serverKeysOf(crypt: Encryption): SdkServerKeys {
    return {
        sealBytes: (plain) => crypt.seal(Buffer.from(plain)),
        openBytes: (sealed) => crypt.openRaw(sealed),
        derive: (salt, info, length) =>
            new Uint8Array(crypto.hkdfSync('sha256', crypt.serverKey(), Buffer.from(salt), Buffer.from(info), length))
    };
}
