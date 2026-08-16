import crypto from 'crypto';
import os from 'os';
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
 * Ce que ce bail apporte, c'est le refus franc plutôt que la corruption muette
 * quand deux processus tournent VRAIMENT en parallèle.
 *
 * ## Ce qu'il ne doit surtout pas faire : bloquer un redémarrage
 *
 * Un conteneur tué par `SIGKILL` (dépassement du délai de grâce Docker, OOM,
 * `docker kill`) ne passe par aucun arrêt propre : le bail reste en base tel
 * quel. Si l'identité du processus était purement aléatoire, le suivant ne
 * reconnaîtrait pas « son » bail et attendrait son expiration, feature morte
 * entre-temps. C'est exactement ce qui est arrivé en production.
 *
 * D'où une identité STABLE par emplacement (hôte + conteneur + dossier de
 * travail) et non par exécution : un redémarrage au même endroit reprend
 * immédiatement le bail qu'il avait laissé, tandis que deux instances
 * réellement distinctes restent distinguées. Un PID s'y ajoute pour départager
 * deux processus lancés côte à côte sur la même machine.
 */

const LEASE_KEY = 'engine_lease';

/**
 * Un bail non renouvelé au-delà est considéré abandonné.
 *
 * Il ne sert plus qu'à récupérer après un déplacement d'instance (nouvel hôte,
 * nouveau conteneur), puisqu'un redémarrage au même endroit se reconnaît. Court
 * quand même : mieux vaut deux moteurs pendant une minute — cas déjà couvert
 * par le mutex de partage — qu'une synchro morte pendant une heure.
 */
export const LEASE_TTL_S = 3 * 60;
/** Cadence du battement. Doit rester TRÈS inférieure au TTL. */
export const LEASE_HEARTBEAT_MS = 30_000;

/**
 * Identité de cet EMPLACEMENT d'exécution, stable d'un redémarrage à l'autre.
 *
 * `os.hostname()` vaut l'identifiant du conteneur sous Docker : il change à
 * chaque recréation, mais pas à un simple redémarrage. On y ajoute le dossier
 * de travail (deux déploiements côte à côte sur un même hôte) et le PID (deux
 * processus dans le même dossier).
 */
function locationId(): string {
    const seed = `${os.hostname()}|${process.cwd()}|${process.pid}`;
    return crypto.createHash('sha256').update(seed).digest('hex').slice(0, 32);
}

export const INSTANCE_ID = locationId();

interface LeaseValue {
    instanceId: string;
    renewedAt: number;
    /** Purement informatif : lisible à l'œil dans `sync_meta` en cas de doute. */
    host?: string;
}

function parse(raw: string | null): LeaseValue | null {
    if (raw === null || raw === '') return null;
    try {
        const parsed = JSON.parse(raw) as Partial<LeaseValue>;
        if (typeof parsed.instanceId !== 'string' || typeof parsed.renewedAt !== 'number') return null;
        return { instanceId: parsed.instanceId, renewedAt: parsed.renewedAt };
    } catch {
        return null;
    }
}

function write(db: Database): Promise<void> {
    return db.syncMeta.set(
        LEASE_KEY,
        JSON.stringify({
            instanceId: INSTANCE_ID,
            renewedAt: Math.floor(Date.now() / 1000),
            host: os.hostname()
        })
    );
}

/**
 * Tente de prendre (ou reprendre) le bail. Rend `false` uniquement si un AUTRE
 * emplacement le tient encore et l'a renouvelé récemment.
 */
export async function acquireLease(db: Database): Promise<boolean> {
    const current = parse(await db.syncMeta.get(LEASE_KEY));
    const stale = current === null || Math.floor(Date.now() / 1000) - current.renewedAt >= LEASE_TTL_S;
    if (current !== null && current.instanceId !== INSTANCE_ID && !stale) return false;
    await write(db);
    return true;
}

/**
 * Libère le bail à l'arrêt propre, pour qu'un redémarrage reprenne la main sans
 * même attendre. Best-effort : un `SIGKILL` ne passe pas par ici, d'où
 * l'identité stable qui rend la reprise possible de toute façon.
 */
export async function releaseLease(db: Database): Promise<void> {
    const current = parse(await db.syncMeta.get(LEASE_KEY));
    if (current === null || current.instanceId !== INSTANCE_ID) return;
    await db.syncMeta.set(LEASE_KEY, '');
}

/**
 * Renouvelle le bail. Rend `false` si un autre emplacement l'a repris
 * entre-temps — auquel cas ce moteur doit se taire.
 */
export async function renewLease(db: Database): Promise<boolean> {
    const current = parse(await db.syncMeta.get(LEASE_KEY));
    if (current !== null && current.instanceId !== INSTANCE_ID) return false;
    await write(db);
    return true;
}
