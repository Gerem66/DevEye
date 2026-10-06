import type Encryption from '@/Services/Encryption';
import { moduleSealLabel } from '@/Services/Encryption';
import type { SdkServerKeys } from '@deveye/types/sdk/server';
import type { MonitorHub } from '@/agent/hub';
import { agentConfigFor } from '@/agent/config';
import type { Database } from '@/db';
import type { LiveHub } from '@/live/hub';

/**
 * Le point d'attache de l'hôte pour l'assemblage SDK : le hub agents (portée
 * flotte, que le `FeatureContext` natif ne transporte pas), le hub de présence
 * (portée salle, qu'un handler n'atteint pas non plus) et la base, déposés une
 * fois au boot, avant l'enregistrement des WS.
 */
let HUB: MonitorHub | null = null;
let DB: Database | null = null;
let LIVE: LiveHub | null = null;

export function setSdkHost(hub: MonitorHub, db: Database, live: LiveHub): void {
    HUB = hub;
    DB = db;
    LIVE = live;
}

export function sdkLive(): LiveHub {
    if (!LIVE) throw new Error('SDK: hub de présence non attaché (setSdkHost manquant au boot)');
    return LIVE;
}

export function sdkHub(): MonitorHub {
    if (!HUB) throw new Error('SDK: hub agents non attaché (setSdkHost manquant au boot)');
    return HUB;
}

export function sdkDb(): Database {
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
    return hub.pushConfig(deviceId, await agentConfigFor(sdkDb(), row));
}

/**
 * Les dérivations de la clé serveur offertes à un module : sceller/ouvrir des
 * octets sous la sous-clé du module (`module:<id>`), et l'HKDF que
 * `scripts/restore-backup.mjs` refait sans DevEye (non étiqueté par module : ce
 * script ne connaît que `CRYPT_KEY_A/B`). La clé elle-même ne sort jamais.
 */
export function serverKeysOf(crypt: Encryption, featureId: string): SdkServerKeys {
    const label = moduleSealLabel(featureId);
    return {
        sealBytes: (plain, context = '') => crypt.sealFor(label, Buffer.from(plain), context),
        openBytes: (sealed, context = '') => crypt.openFor(label, sealed, context),
        derive: (salt, info, length) => new Uint8Array(crypt.derive(salt, info, length))
    };
}
