import crypto from 'node:crypto';
import type Encryption from '@/Services/Encryption';
import type { SdkServerKeys } from '@deveye/types/sdk/server';
import type { MonitorHub } from '@/agent/hub';
import { agentConfigFor } from '@/agent/config';
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
 * depuis la ligne appareil et ce que les modules y contribuent
 * (`agentConfigFor`, qui demande à Sentinelle sa part). Faux quand l'agent est
 * hors ligne : il recevra la config à sa prochaine connexion, le chemin de
 * `agent/ws.ts` la rejoue à chaque poignée de main.
 *
 * `agent/config.ts` importe `_sdk/register`, qui remonte jusqu'ici par la
 * façade : le cycle est assumé et sans effet, rien n'y est évalué au
 * chargement (deux fonctions qui s'appellent à l'exécution).
 */
export async function pushAgentConfig(deviceId: string): Promise<boolean> {
    const hub = sdkHub();
    if (!hub.isOnline(deviceId)) return false;
    const row = await sdkDb().devices.findById(deviceId);
    if (!row) return false;
    return hub.pushConfig(deviceId, await agentConfigFor(row));
}

/**
 * Les dérivations de la clé serveur offertes à un module (`keys` du contexte
 * et des services) : sceller/ouvrir des octets sous la clé serveur, et l'HKDF
 * que `scripts/restore-backup.mjs` refait sans DevEye à partir des deux
 * seules variables CRYPT_KEY_A / CRYPT_KEY_B. La clé elle-même ne sort jamais.
 */
export function serverKeysOf(crypt: Encryption): SdkServerKeys {
    return {
        sealBytes: (plain) => crypt.seal(Buffer.from(plain)),
        openBytes: (sealed) => crypt.openRaw(sealed),
        derive: (salt, info, length) =>
            new Uint8Array(crypto.hkdfSync('sha256', crypt.serverKey(), Buffer.from(salt), Buffer.from(info), length))
    };
}
