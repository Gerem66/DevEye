import type { SyncDeviceFileRow, SyncEntryKind, SyncFileRow, SyncIndexEntry } from 'deveye-types';
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
    /** `dir` = dossier VIDE (aucun octet ne transite pour lui). */
    kind: SyncEntryKind;
    hash: string;
    size: number;
    /** Millisecondes unix. */
    mtime: number;
    /** Permissions Unix (`& 0o777`) ; `null` = inconnu. */
    mode: number | null;
}

export interface PlanConflict {
    winner: 'device' | 'server';
    device: PlanFile;
    server: PlanFile;
}

/**
 * Un déplacement ou un renommage : le MÊME contenu quitte un chemin pour un
 * autre. Apparié parce que traiter les deux moitiés séparément coûte deux
 * copies parfaitement inutiles du fichier — une version côté serveur, et une
 * entrée de corbeille chez chaque pair — pour une opération qui ne détruit
 * rien.
 */
export interface PlanMove {
    from: PlanFile;
    to: PlanFile;
}

/** Un changement de permissions seul : même contenu, aucun transfert. */
export interface PlanModeChange {
    /** Vers où pousser le mode : l'index serveur, ou l'appareil. */
    target: 'server' | 'device';
    file: PlanFile;
    mode: number;
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
    /** Contenu identique, permissions divergentes : `chmod` sans transfert. */
    modeChanges: PlanModeChange[];
    /** Déplacements/renommages appariés (voir {@link PlanMove}). */
    moves: PlanMove[];
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
 * Arbitre un mode divergent à contenu identique, sur le même schéma 3 voies que
 * le contenu : si l'appareil seul a bougé, il pousse ; sinon le serveur fait
 * foi. Un agent Windows renvoie `null` (il n'a pas de bits Unix) — ce n'est PAS
 * un changement, sinon un simple passage sur Windows effacerait le bit
 * exécutable de tout le monde.
 */
function planModeChange(
    plan: Plan,
    file: PlanFile,
    deviceMode: number | null,
    serverMode: number | null,
    baseMode: number | null
): void {
    // L'appareil n'a pas la notion de permissions (Windows) : il n'y a rien à
    // lui pousser, et surtout rien à conclure. Lui envoyer le mode serveur
    // rejouerait le même ordre À CHAQUE SESSION, indéfiniment — son scan
    // suivant annoncerait toujours `null`, un aller-retour par fichier pour
    // rien. Le mode reste conservé côté serveur (`COALESCE` dans `upsert`), ce
    // qui suffit à le rendre aux machines Unix.
    if (deviceMode === null) return;
    if (deviceMode === serverMode) return;
    const deviceChanged = baseMode !== null && deviceMode !== baseMode;
    if (serverMode === null || deviceChanged) {
        plan.modeChanges.push({ target: 'server', file, mode: deviceMode });
    } else {
        plan.modeChanges.push({ target: 'device', file, mode: serverMode });
    }
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

/**
 * Tous les dossiers ancêtres d'un ensemble de chemins de fichiers.
 * `a/b/c.txt` produit `a` et `a/b`.
 */
function ancestorDirs(filePaths: Iterable<string>): Set<string> {
    const dirs = new Set<string>();
    for (const p of filePaths) {
        let cut = p.lastIndexOf('/');
        while (cut > 0) {
            const dir = p.slice(0, cut);
            if (dirs.has(dir)) break; // Les ancêtres au-dessus sont déjà là.
            dirs.add(dir);
            cut = dir.lastIndexOf('/');
        }
    }
    return dirs;
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
        modeChanges: [],
        moves: [],
        dropBaseline: [],
        skipped: [],
        filesTotal: 0,
        bytesTotal: 0
    };

    const device = new Map(deviceIndex.map((e) => [e.relPath, e]));
    const base = new Map(baseline.map((b) => [b.rel_path, b]));
    const srv = new Map(server.map((s) => [s.rel_path, s]));

    // Un dossier n'est indexé que TANT QU'IL EST VIDE. Dès qu'un fichier
    // apparaît dessous, son entrée `dir` devient un fantôme : le scan ne la
    // remonte plus, et la règle « présent côté serveur, absent côté appareil,
    // baseline concordante » conclurait à tort à une suppression — qui se
    // propagerait ensuite au dossier PEUPLÉ des autres appareils. On écarte donc
    // toute entrée `dir` qui préfixe un fichier vivant, des deux côtés.
    const liveFiles = [
        ...[...device.values()].filter((e) => e.kind !== 'dir').map((e) => e.relPath),
        ...[...srv.values()].filter((s) => s.kind !== 'dir' && s.state === 'present').map((s) => s.rel_path)
    ];
    const populated = ancestorDirs(liveFiles);
    const isGhostDir = (relPath: string, kind: SyncEntryKind): boolean => kind === 'dir' && populated.has(relPath);
    for (const [relPath, entry] of device) if (isGhostDir(relPath, entry.kind)) device.delete(relPath);
    for (const [relPath, row] of srv) if (isGhostDir(relPath, row.kind)) srv.delete(relPath);
    for (const [relPath, row] of base) if (isGhostDir(relPath, row.kind)) base.delete(relPath);

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

        const toPlanFile = (src: {
            kind: SyncEntryKind;
            hash: string;
            size: number;
            mtime: number;
            mode: number | null;
        }): PlanFile => ({
            relPath,
            kind: src.kind,
            hash: src.hash,
            size: src.size,
            mtime: src.mtime,
            mode: src.mode
        });

        if (d && sPresent) {
            if (d.kind !== s.kind) {
                // Dossier d'un côté, fichier de l'autre : aucune fusion n'a de
                // sens et écraser l'un par l'autre détruirait du contenu. On
                // laisse les deux en place et on le signale.
                plan.skipped.push({
                    relPath,
                    reason: `Conflit de nature : ${d.kind === 'dir' ? 'dossier' : 'fichier'} sur l’appareil, ${
                        s.kind === 'dir' ? 'dossier' : 'fichier'
                    } côté serveur`
                });
                continue;
            }
            if (sameContent(d.hash, s.hash)) {
                // Synchronisé. Baseline absente ou périmée → à rafraîchir (sans transfert).
                if (!b || !sameContent(b.hash, d.hash)) plan.refreshBaseline.push(toPlanFile(d));
                // Un `chmod` ne change pas le hash : sans ce cas, un bit
                // exécutable posé sur une machine ne partirait jamais ailleurs.
                else planModeChange(plan, toPlanFile(d), d.mode, s.mode, b.mode);
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

    // ─── Appariement des déplacements ──────────────────────────────────────
    //
    // Une suppression et un ajout du MÊME contenu, dans la même session, sont
    // les deux moitiés d'un déplacement. Les laisser séparés reviendrait à
    // archiver l'ancien chemin en version ET à mettre une copie à la corbeille
    // chez chaque pair — deux copies intégrales pour une opération qui ne perd
    // rien. On les recolle, et la session se contentera de renommer.
    //
    // Seuls les fichiers sont appariés : un dossier vide n'a pas de contenu qui
    // permette de reconnaître qu'il s'agit du même.
    const removedByHash = new Map<string, PlanFile[]>();
    for (const gone of plan.deleteOnServer) {
        if (gone.kind === 'dir') continue;
        const bucket = removedByHash.get(gone.hash);
        if (bucket) bucket.push(gone);
        else removedByHash.set(gone.hash, [gone]);
    }

    if (removedByHash.size > 0) {
        const remainingUploads: PlanFile[] = [];
        const moved = new Set<PlanFile>();
        for (const added of plan.uploads) {
            const bucket = added.kind === 'dir' ? undefined : removedByHash.get(added.hash);
            const from = bucket?.shift();
            if (from === undefined) {
                remainingUploads.push(added);
                continue;
            }
            moved.add(from);
            plan.moves.push({ from, to: added });
        }
        plan.uploads = remainingUploads;
        plan.deleteOnServer = plan.deleteOnServer.filter((f) => !moved.has(f));
    }

    const transfers = [
        ...plan.uploads,
        ...plan.downloads,
        ...plan.conflicts.map((c) => (c.winner === 'device' ? c.device : c.server))
    ];
    plan.filesTotal =
        transfers.length +
        plan.deleteOnServer.length +
        plan.deleteOnDevice.length +
        plan.modeChanges.length +
        plan.moves.length;
    // Les conflits comptent aussi l'archivage du perdant côté appareil (upload).
    const conflictLoserBytes = plan.conflicts
        .filter((c) => c.winner === 'server')
        .reduce((sum, c) => sum + c.device.size, 0);
    plan.bytesTotal = transfers.reduce((sum, f) => sum + f.size, 0) + conflictLoserBytes;

    return plan;
}

/**
 * Empreinte du travail décrit par un plan, indépendante de l'ordre.
 *
 * Sert à reconnaître une session qui reprend, à l'identique, un travail qui
 * vient d'échouer : même empreinte ⇒ mêmes chemins, mêmes contenus, mêmes
 * opérations, donc aucun progrès à annoncer. Voir `SyncSession.isVisible`.
 *
 * Volontairement construite sur le chemin ET le contenu : un fichier réécrit
 * entre deux tentatives change de hash, donc d'empreinte, et la reprise
 * redevient visible. Le tri rend l'empreinte insensible à l'ordre d'énumération
 * de la base, qui n'est garanti nulle part.
 */
export function planSignature(plan: Plan): string {
    const parts: string[] = [];
    const add = (tag: string, files: { relPath: string; hash: string }[]): void => {
        for (const f of files) parts.push(`${tag} ${f.relPath} ${f.hash}`);
    };
    add('up', plan.uploads);
    add('down', plan.downloads);
    add('delS', plan.deleteOnServer);
    add('delD', plan.deleteOnDevice);
    for (const m of plan.modeChanges) parts.push(`mode ${m.target} ${m.file.relPath} ${m.mode}`);
    for (const m of plan.moves) parts.push(`mv ${m.from.relPath} ${m.to.relPath} ${m.to.hash}`);
    for (const c of plan.conflicts) parts.push(`cf ${c.device.relPath} ${c.winner}`);
    for (const s of plan.skipped) parts.push(`skip ${s.relPath} ${s.reason}`);
    parts.sort();
    return parts.join('\n');
}
