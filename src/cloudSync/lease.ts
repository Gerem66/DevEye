import crypto from 'crypto';
import type { Database } from '../db';

/**
 * Bail d'instance : un seul processus fait tourner le moteur CloudSync.
 *
 * Ce n'est PAS une coordination distribuée, et c'est délibéré. Une session
 * CloudSync est un dialogue multi-aller-retour sur la WebSocket de l'agent,
 * laquelle est épinglée au processus où l'agent s'est connecté : une seconde
 * instance qui gagnerait un verrou sans détenir cette socket ne pourrait rien
 * synchroniser du tout, en silence. Un verrou par partage EMPIRERAIT donc les
 * choses. Voir `Docs/CLOUDSYNC.md`.
 *
 * Ce que ce bail apporte, c'est le refus franc plutôt que la corruption muette.
 * Sans lui, un second processus qui démarre :
 *  - appelle `failStale(now)` et passe en `error` TOUTES les sessions en cours
 *    du premier (la requête n'a pas de colonne propriétaire) ;
 *  - lance des GC et des purges en parallèle des transferts du premier, ce qui
 *    peut casser l'invariant « rien n'est détruit sans version vérifiée » ;
 *  - vide les `tmp/` du store sous les pieds de l'autre.
 *
 * Le bail expire tout seul : un processus tué net ne laisse pas un verrou
 * éternel, le suivant reprend la main après {@link LEASE_TTL_S}.
 */

const LEASE_KEY = 'engine_lease';
/**
 * Un bail non renouvelé au-delà est considéré abandonné.
 *
 * COURT, et c'est le point important : l'identité d'une instance est un UUID
 * neuf à chaque démarrage, donc un processus qui redémarre ne peut pas
 * reconnaître « son » ancien bail. Avec un TTL long, chaque déploiement
 * laisserait la synchro à l'arrêt jusqu'à expiration. Cinq minutes, renouvelées
 * toutes les minutes par un battement dédié (et libérées à l'arrêt propre), et
 * un redémarrage reprend la main immédiatement ou presque.
 */
export const LEASE_TTL_S = 5 * 60;
/** Cadence du battement. Doit rester TRÈS inférieure au TTL. */
export const LEASE_HEARTBEAT_MS = 60_000;

/** Identité de CE processus, le temps de sa vie. */
export const INSTANCE_ID = crypto.randomUUID();

interface LeaseValue {
    instanceId: string;
    renewedAt: number;
}

function parse(raw: string | null): LeaseValue | null {
    if (raw === null) return null;
    try {
        const parsed = JSON.parse(raw) as Partial<LeaseValue>;
        if (typeof parsed.instanceId !== 'string' || typeof parsed.renewedAt !== 'number') return null;
        return { instanceId: parsed.instanceId, renewedAt: parsed.renewedAt };
    } catch {
        return null;
    }
}

/**
 * Tente de prendre (ou reprendre) le bail. Rend `false` si un AUTRE processus
 * le tient encore : l'appelant doit alors rester passif.
 */
export async function acquireLease(db: Database): Promise<boolean> {
    const now = Math.floor(Date.now() / 1000);
    const current = parse(await db.syncMeta.get(LEASE_KEY));
    if (current !== null && current.instanceId !== INSTANCE_ID && now - current.renewedAt < LEASE_TTL_S) {
        return false;
    }
    await db.syncMeta.set(LEASE_KEY, JSON.stringify({ instanceId: INSTANCE_ID, renewedAt: now }));
    return true;
}

/**
 * Libère le bail à l'arrêt propre, pour qu'un redémarrage reprenne la main sans
 * attendre l'expiration. Best-effort : un `kill -9` ne passe pas par ici, d'où
 * un TTL court en filet.
 */
export async function releaseLease(db: Database): Promise<void> {
    const current = parse(await db.syncMeta.get(LEASE_KEY));
    if (current === null || current.instanceId !== INSTANCE_ID) return;
    await db.syncMeta.set(LEASE_KEY, '');
}

/**
 * Renouvelle le bail. Rend `false` si un autre processus l'a repris entre-temps
 * — auquel cas ce moteur doit se taire.
 */
export async function renewLease(db: Database): Promise<boolean> {
    const current = parse(await db.syncMeta.get(LEASE_KEY));
    if (current !== null && current.instanceId !== INSTANCE_ID) return false;
    await db.syncMeta.set(
        LEASE_KEY,
        JSON.stringify({ instanceId: INSTANCE_ID, renewedAt: Math.floor(Date.now() / 1000) })
    );
    return true;
}
