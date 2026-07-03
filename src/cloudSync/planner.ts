import type { SyncDeviceFileRow, SyncFileRow, SyncIndexEntry } from 'deveye-types';
import { SYNC_MTIME_SKEW_MS } from 'deveye-types';

/**
 * Merge 3 voies — pur, sans I/O, déterministe.
 *
 * Trois vues d'un même partage pour UN appareil :
 *  - `device`   : ce que l'appareil a maintenant (scan frais) ;
 *  - `baseline` : ce que l'appareil avait à la fin de sa dernière session ;
 *  - `server`   : l'index canonique (y compris les lignes `deleted`).
 *
 * Règle d'or anti-perte : une suppression n'est JAMAIS inférée sans ligne de
 * baseline. Baseline vide (premier sync, re-attach) ⇒ merge pur, aucune
 * suppression possible, dans aucun sens.
 *
 * Conflits (modifié des deux côtés) : last-writer-wins sur le mtime avec
 * tolérance {@link SYNC_MTIME_SKEW_MS} ; à égalité le serveur gagne. Le perdant
 * est TOUJOURS archivé par la session avant que le gagnant n'écrase quoi que
 * ce soit.
 */

export interface PlanFile {
    relPath: string;
    hash: string;
    size: number;
    /** Millisecondes unix. */
    mtime: number;
}

export interface PlanConflict {
    winner: 'device' | 'server';
    device: PlanFile;
    server: PlanFile;
}

export interface Plan {
    /** Appareil → serveur (nouveau ou modifié côté appareil). */
    uploads: PlanFile[];
    /** Serveur → appareil (contenu depuis l'index canonique). */
    downloads: PlanFile[];
    /** Supprimé sur l'appareil → archiver puis marquer `deleted` côté serveur. */
    deleteOnServer: PlanFile[];
    /** Supprimé côté serveur → corbeille locale de l'appareil. */
    deleteOnDevice: PlanFile[];
    /** Modifié des deux côtés : le perdant est archivé, puis le gagnant propage. */
    conflicts: PlanConflict[];
    /** Déjà synchronisé mais baseline absente/périmée : à réécrire sans transfert. */
    refreshBaseline: PlanFile[];
    /** Baselines orphelines (chemin disparu des deux côtés) : à purger. */
    dropBaseline: string[];
    /** Chemins ignorés avec raison (collisions de casse…) — remontés en warning. */
    skipped: { relPath: string; reason: string }[];
    /** Totaux du travail à faire (pour la barre de progression). */
    filesTotal: number;
    bytesTotal: number;
}

function sameContent(aHash: string, bHash: string): boolean {
    return aHash === bHash;
}

/**
 * Détecte les chemins qui n'existeraient pas tous sur un FS insensible à la
 * casse. Les entrées sont dédupliquées d'abord : un même chemin vu côté
 * appareil ET côté serveur (le cas normal d'un fichier synchronisé) n'est
 * évidemment pas une collision — seuls des chemins DISTINCTS qui ne diffèrent
 * que par la casse en sont une.
 */
function caseCollisions(paths: Iterable<string>): Set<string> {
    const byLower = new Map<string, Set<string>>();
    for (const p of paths) {
        const key = p.toLowerCase();
        const set = byLower.get(key);
        if (set) set.add(p);
        else byLower.set(key, new Set([p]));
    }
    const collided = new Set<string>();
    for (const set of byLower.values()) {
        if (set.size > 1) for (const p of set) collided.add(p);
    }
    return collided;
}

export function planSession(
    deviceIndex: ReadonlyArray<SyncIndexEntry>,
    baseline: ReadonlyArray<SyncDeviceFileRow>,
    server: ReadonlyArray<SyncFileRow>
): Plan {
    const plan: Plan = {
        uploads: [],
        downloads: [],
        deleteOnServer: [],
        deleteOnDevice: [],
        conflicts: [],
        refreshBaseline: [],
        dropBaseline: [],
        skipped: [],
        filesTotal: 0,
        bytesTotal: 0
    };

    const device = new Map(deviceIndex.map((e) => [e.relPath, e]));
    const base = new Map(baseline.map((b) => [b.rel_path, b]));
    const srv = new Map(server.map((s) => [s.rel_path, s]));

    const collided = caseCollisions(
        (function* () {
            yield* device.keys();
            yield* srv.keys();
        })()
    );

    const allPaths = new Set<string>([...device.keys(), ...srv.keys(), ...base.keys()]);

    for (const relPath of allPaths) {
        if (collided.has(relPath)) {
            plan.skipped.push({
                relPath,
                reason: 'Collision de casse (plusieurs chemins identiques à la casse près)'
            });
            continue;
        }

        const d = device.get(relPath);
        const b = base.get(relPath);
        const s = srv.get(relPath);
        const sPresent = s !== undefined && s.state === 'present';

        const toPlanFile = (src: { hash: string; size: number; mtime: number }): PlanFile => ({
            relPath,
            hash: src.hash,
            size: src.size,
            mtime: src.mtime
        });

        if (d && sPresent) {
            if (sameContent(d.hash, s.hash)) {
                // Synchronisé. Baseline absente ou périmée → à rafraîchir (sans transfert).
                if (!b || !sameContent(b.hash, d.hash)) plan.refreshBaseline.push(toPlanFile(d));
                continue;
            }
            const deviceChanged = !b || !sameContent(b.hash, d.hash);
            const serverChanged = !b || !sameContent(b.hash, s.hash);
            if (deviceChanged && !serverChanged) plan.uploads.push(toPlanFile(d));
            else if (!deviceChanged && serverChanged) plan.downloads.push(toPlanFile(s));
            else {
                const winner = d.mtime > s.mtime + SYNC_MTIME_SKEW_MS ? 'device' : 'server';
                plan.conflicts.push({ winner, device: toPlanFile(d), server: toPlanFile(s) });
            }
            continue;
        }

        if (d && !sPresent) {
            if (s && s.state === 'deleted' && b && sameContent(b.hash, d.hash)) {
                // Supprimé côté serveur après la dernière session ; l'appareil n'a
                // pas retouché le fichier → la suppression se propage (corbeille).
                plan.deleteOnDevice.push(toPlanFile(d));
            } else {
                // Nouveau sur l'appareil, ou modifié depuis la suppression serveur :
                // on remonte le contenu (résurrection) — jamais de perte silencieuse.
                plan.uploads.push(toPlanFile(d));
            }
            continue;
        }

        if (!d && sPresent) {
            if (b && sameContent(b.hash, s.hash)) {
                // L'appareil l'avait, le serveur n'a pas bougé → vraie suppression
                // appareil : archiver côté serveur puis marquer `deleted`.
                plan.deleteOnServer.push(toPlanFile(s));
            } else {
                // Jamais eu (pas de baseline) OU le serveur a évolué depuis :
                // le contenu serveur redescend. Rien n'est détruit.
                plan.downloads.push(toPlanFile(s));
            }
            continue;
        }

        // Plus de fichier ni côté appareil ni côté serveur : baseline orpheline.
        if (b) plan.dropBaseline.push(relPath);
    }

    const transfers = [
        ...plan.uploads,
        ...plan.downloads,
        ...plan.conflicts.map((c) => (c.winner === 'device' ? c.device : c.server))
    ];
    plan.filesTotal = transfers.length + plan.deleteOnServer.length + plan.deleteOnDevice.length;
    // Les conflits comptent aussi l'archivage du perdant côté appareil (upload).
    const conflictLoserBytes = plan.conflicts
        .filter((c) => c.winner === 'server')
        .reduce((sum, c) => sum + c.device.size, 0);
    plan.bytesTotal = transfers.reduce((sum, f) => sum + f.size, 0) + conflictLoserBytes;

    return plan;
}
