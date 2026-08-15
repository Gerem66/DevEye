import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { SYNC_REL_PATH_MAX, SYNC_STORAGE_PATH_MAX } from 'deveye-types';
import type { Database } from '../db';
import { BLOB_STORE_SUBDIRS } from './blobStore';

/**
 * Garde-fous de chemins. Deux mondes :
 *  - les chemins RELATIFS reçus des agents (`relPath`) — jamais utilisés pour
 *    construire un chemin disque côté serveur (le CAS est adressé par hash),
 *    mais validés quand même à la frontière : défense en profondeur ;
 *  - le chemin de STOCKAGE d'un partage, absolu, choisi par l'utilisateur.
 */

/** Préfixes réservés à l'agent dans le dossier local (jamais synchronisés). */
export const RESERVED_TOP_DIRS = ['.deveye-trash', '.deveye-tmp'] as const;

const CONTROL_CHARS = /[\u0000-\u001f]/;

/** Vrai si la chaîne contient un caractère de contrôle (C0). */
export function hasControlChars(value: string): boolean {
    return CONTROL_CHARS.test(value);
}

/** Normalise en NFC — macOS émet du NFD, tout le reste du monde du NFC. */
export function normalizeRelPath(relPath: string): string {
    return relPath.normalize('NFC');
}

/** SHA-256 hex du chemin relatif NFC-normalisé (clé d'unicité en BDD). */
export function relPathHash(relPath: string): string {
    return crypto.createHash('sha256').update(normalizeRelPath(relPath), 'utf8').digest('hex');
}

/**
 * Caractères qu'un nom de fichier NTFS/Win32 ne peut pas porter. Un partage est
 * censé être identique sur les trois OS : accepter dans le « cloud » un nom que
 * Windows ne sait pas écrire condamnerait l'agent Windows à échouer sur ce
 * fichier à chaque cycle, indéfiniment, et à diverger pour toujours. Le refus
 * est donc GLOBAL, quel que soit l'OS qui a créé le fichier — la copie locale
 * sur sa machine d'origine, elle, reste évidemment intacte.
 */
const WINDOWS_FORBIDDEN_CHARS = /["*:<>?|]/;

/** Noms de périphériques DOS, réservés avec ou sans extension. */
const WINDOWS_RESERVED_NAMES = /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/i;

/** Limite d'un composant de chemin sur la quasi-totalité des systèmes de fichiers. */
const SEGMENT_MAX_BYTES = 255;

/** Le problème d'un composant de chemin, ou `null` s'il est portable partout. */
function segmentProblem(segment: string): string | null {
    if (segment === '' || segment === '.' || segment === '..') {
        return 'segment de chemin vide ou relatif';
    }
    if (Buffer.byteLength(segment, 'utf8') > SEGMENT_MAX_BYTES) {
        return `nom de plus de ${SEGMENT_MAX_BYTES} octets`;
    }
    const bad = WINDOWS_FORBIDDEN_CHARS.exec(segment);
    if (bad !== null) return `caractère « ${bad[0]} » interdit sous Windows`;
    if (WINDOWS_RESERVED_NAMES.test(segment)) return `« ${segment} » est un nom réservé sous Windows`;
    // Windows tronque silencieusement les points et espaces de fin : deux noms
    // distincts ailleurs y deviendraient le même fichier.
    if (segment.endsWith('.')) return 'nom terminé par un point (impossible sous Windows)';
    if (segment.endsWith(' ')) return 'nom terminé par une espace (impossible sous Windows)';
    return null;
}

/**
 * Le problème d'un chemin relatif, ou `null` s'il est synchronisable partout.
 * C'est LA règle de nommage du partage, partagée mot pour mot avec l'agent
 * (`agent/src/sync/paths.rs::rel_path_problem`). Renvoyer la raison plutôt
 * qu'un booléen permet de la journaliser telle quelle dans la popup « Logs ».
 */
export function relPathProblem(relPath: string): string | null {
    if (relPath.length === 0) return 'chemin vide';
    if (relPath.length > SYNC_REL_PATH_MAX) return `chemin de plus de ${SYNC_REL_PATH_MAX} caractères`;
    if (relPath.includes('\\')) return 'antislash interdit dans un chemin';
    if (hasControlChars(relPath)) return 'caractère de contrôle interdit';
    const segments = normalizeRelPath(relPath).split('/');
    if ((RESERVED_TOP_DIRS as readonly string[]).includes(segments[0])) {
        return `« ${segments[0]} » est un dossier réservé à l'agent`;
    }
    for (const segment of segments) {
        const problem = segmentProblem(segment);
        if (problem !== null) return problem;
    }
    return null;
}

/**
 * Un chemin relatif sûr : slashes avant uniquement, pas d'échappement, et
 * portable sur les trois OS (voir {@link relPathProblem}). Retourne la forme
 * NFC-normalisée, ou `null` si refusé.
 */
export function safeRelPath(relPath: string): string | null {
    return relPathProblem(relPath) === null ? normalizeRelPath(relPath) : null;
}

export interface StoragePathVerdict {
    ok: boolean;
    freeBytes: number | null;
    /** Raison du refus (français), quand `!ok`. */
    problem: string | null;
}

/**
 * Valide un chemin de stockage de partage : absolu, normalisé, pas la racine,
 * non imbriqué avec un autre partage, créable et inscriptible. Renvoie
 * l'espace libre du volume pour l'afficher dans le wizard.
 */
export async function validateStoragePath(db: Database, rawPath: string): Promise<StoragePathVerdict> {
    const refuse = (problem: string): StoragePathVerdict => ({ ok: false, freeBytes: null, problem });

    const trimmed = rawPath.trim();
    if (trimmed.length === 0 || trimmed.length > SYNC_STORAGE_PATH_MAX) {
        return refuse('Chemin vide ou trop long.');
    }
    if (CONTROL_CHARS.test(trimmed)) return refuse('Chemin invalide (caractères de contrôle).');
    if (!path.isAbsolute(trimmed)) return refuse('Le chemin doit être absolu.');

    const resolved = path.resolve(trimmed);
    if (resolved === path.parse(resolved).root) {
        return refuse('La racine du système ne peut pas servir de stockage.');
    }

    const overlapping = await db.syncShares.pathsOverlapping(resolved);
    if (overlapping.length > 0) {
        return refuse(`Chemin en conflit avec le partage « ${overlapping[0].name} ».`);
    }

    try {
        await fs.mkdir(resolved, { recursive: true });
    } catch {
        return refuse('Impossible de créer le dossier (droits insuffisants ?).');
    }

    // Le dossier doit être NEUF (vide) ou être un ancien stockage DevEye
    // (`blobs/` + `tmp/` seulement). C'est ce qui autorise la suppression d'un
    // partage à effacer son contenu sans jamais risquer des fichiers étrangers.
    try {
        const entries = await fs.readdir(resolved);
        const foreign = entries.filter((e) => !(BLOB_STORE_SUBDIRS as readonly string[]).includes(e));
        if (foreign.length > 0) {
            return refuse('Le dossier doit être vide (ou être un ancien stockage DevEye).');
        }
    } catch {
        return refuse('Dossier illisible.');
    }

    const probe = path.join(resolved, `.deveye-probe-${crypto.randomBytes(6).toString('hex')}`);
    try {
        await fs.writeFile(probe, 'ok');
        await fs.rm(probe, { force: true });
    } catch {
        return refuse('Le dossier n’est pas inscriptible.');
    }

    let freeBytes: number | null = null;
    try {
        const stat = await fs.statfs(resolved);
        freeBytes = Number(stat.bavail) * Number(stat.bsize);
    } catch {
        freeBytes = null; // Non bloquant : l'espace libre est informatif.
    }

    return { ok: true, freeBytes, problem: null };
}

/** La forme canonique (résolue) d'un chemin de stockage déjà validé. */
export function canonicalStoragePath(rawPath: string): string {
    return path.resolve(rawPath.trim());
}
