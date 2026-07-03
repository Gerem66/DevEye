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
 * Un chemin relatif sûr : non vide, ≤ 1024, slashes avant uniquement, pas de
 * segment vide/`.`/`..`, pas de `\`, pas de caractère de contrôle, pas de
 * préfixe réservé. Retourne la forme NFC-normalisée, ou `null` si refusé.
 */
export function safeRelPath(relPath: string): string | null {
    if (relPath.length === 0 || relPath.length > SYNC_REL_PATH_MAX) return null;
    if (relPath.includes('\\') || CONTROL_CHARS.test(relPath)) return null;
    const normalized = normalizeRelPath(relPath);
    const segments = normalized.split('/');
    for (const seg of segments) {
        if (seg === '' || seg === '.' || seg === '..') return null;
    }
    if ((RESERVED_TOP_DIRS as readonly string[]).includes(segments[0])) return null;
    return normalized;
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
