import { hkdfSync, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { deflateRaw, inflateRaw } from 'node:zlib';

import {
    FeatureError,
    type SdkCipher,
    type SdkFeatureContext,
    type SdkObjectStore,
    type SdkQuota,
    type SdkServerKeys
} from '@deveye/types/sdk/server';
import { z } from 'zod';

import {
    backgroundSchema,
    boardThemeSchema,
    sceneElementSchema,
    type BoardAppearance,
    type BoardSummary,
    type SceneElement
} from '../contracts/domain';
import type { BoardRow, WhiteboardRepo } from './repo';
import type { Sessions } from './session/sessions';

export type Ctx = SdkFeatureContext<WhiteboardRepo>;

export const now = (): number => Math.floor(Date.now() / 1000);

// ── Le titre ───────────────────────────────────────────────────────────────

const contentSchema = z.object({ title: z.string() });

export function sealTitle(cipher: SdkCipher, title: string): Promise<string> {
    return cipher.encrypt(JSON.stringify({ title }));
}

/** Un titre illisible garde le tableau listable et supprimable. */
export async function openTitle(cipher: SdkCipher, blob: string): Promise<string> {
    const plain = await cipher.tryDecrypt(blob);
    if (plain === null) return '';
    try {
        const parsed = contentSchema.safeParse(JSON.parse(plain));
        return parsed.success ? parsed.data.title : '';
    } catch {
        return '';
    }
}

/** Ce que la base porte, relu sans y croire : une valeur hors du contrat vaut celle par défaut. */
export function appearanceOf(row: { background: unknown; theme: unknown }): BoardAppearance {
    const background = backgroundSchema.safeParse(row.background);
    const theme = boardThemeSchema.safeParse(row.theme);
    return { background: background.success ? background.data : null, theme: theme.success ? theme.data : null };
}

export function summaryOf(row: BoardRow, title: string, foreign: boolean): BoardSummary {
    return {
        id: row.id,
        title,
        createdAt: Number(row.created),
        updatedAt: Number(row.updated),
        updatedBy: row.updated_by,
        byteSize: Number(row.scene_bytes) + Number(row.preview_bytes) + Number(row.files_bytes),
        hasPreview: Number(row.has_preview) === 1,
        previewVersion: Number(row.preview_version),
        foreign,
        ...appearanceOf(row)
    };
}

// ── La scène ───────────────────────────────────────────────────────────────
// Compressée avant scellement : un dessin est un JSON très redondant (des
// tableaux de points), qui se réduit de cinq à dix fois.

const zip = promisify(deflateRaw);
const unzip = promisify(inflateRaw);
const ZIPPED = 'z1:';

const storedSceneSchema = z.object({ elements: z.array(sceneElementSchema) });

export interface EncodedScene {
    sealed: string;
    /** Le JSON en clair, en octets : ce que le quota et le plafond comptent. */
    bytes: number;
}

export function sceneJson(elements: readonly SceneElement[]): string {
    return JSON.stringify({ elements });
}

export async function sealScene(cipher: SdkCipher, json: string): Promise<EncodedScene> {
    const packed = await zip(Buffer.from(json, 'utf8'));
    return { sealed: await cipher.encrypt(ZIPPED + packed.toString('base64')), bytes: Buffer.byteLength(json, 'utf8') };
}

/** `null` quand la scène ne s'ouvre pas : le tableau reste, vide à l'écran plutôt qu'en panne. */
export async function openScene(cipher: SdkCipher, sealed: string): Promise<SceneElement[] | null> {
    const plain = await cipher.tryDecrypt(sealed);
    if (plain === null) return null;
    try {
        const json = plain.startsWith(ZIPPED)
            ? (await unzip(Buffer.from(plain.slice(ZIPPED.length), 'base64'))).toString('utf8')
            : plain;
        const parsed = storedSceneSchema.safeParse(JSON.parse(json));
        return parsed.success ? parsed.data.elements : null;
    } catch {
        return null;
    }
}

/** Les images que la scène montre encore : ce qui n'y figure plus devient orphelin. */
export function fileIdsOf(elements: Iterable<SceneElement>): string[] {
    const ids = new Set<string>();
    for (const el of elements) {
        if (!el.isDeleted && el.type === 'image' && typeof el.fileId === 'string') ids.add(el.fileId);
    }
    return [...ids];
}

// ── Les clés du module ─────────────────────────────────────────────────────
// Dérivées d'une racine tirée au sort au premier démarrage et scellée par la
// clé du serveur dans `ft_whiteboard_key`, déclarée dans `serverEntry.sealed` :
// une rotation la ré-emballe sans toucher aux images. Aucune ne dépend d'un
// espace : un tableau copié ou déplacé garde ses images telles quelles.

export interface WhiteboardKeys {
    /** Scelle les images dans le magasin d'objets (conteneur `DEVB` v2). */
    files: Buffer;
}

const KEY_SALT = 'deveye-whiteboard';
export const KEY_CONTEXT = 'ft_whiteboard_key:sealed';

export async function loadWhiteboardKeys(
    repo: Pick<WhiteboardRepo, 'key'>,
    keys: SdkServerKeys
): Promise<WhiteboardKeys> {
    let sealed = await repo.key.sealed();
    if (sealed === null) {
        await repo.key.insertSealed(keys.sealBytes(randomBytes(32), KEY_CONTEXT));
        sealed = await repo.key.sealed();
    }
    const root = sealed === null ? null : keys.openBytes(sealed, KEY_CONTEXT);
    if (root === null || root.length !== 32) {
        throw new Error('Tableau blanc : la clé du module ne s’ouvre pas (CRYPT_KEY_A/B changées sans rotation ?)');
    }
    return { files: Buffer.from(hkdfSync('sha256', root, KEY_SALT, 'files-v1', 32)) };
}

/** Tirée au sort : seul qui lit la ligne connaît l'objet, et une copie en reçoit une autre. */
export function newObjectKey(): string {
    return `img/${randomBytes(16).toString('hex')}`;
}

export const OBJECT_KEY_PATTERN = /^img\/[0-9a-f]{32}$/;

// ── Le runtime ─────────────────────────────────────────────────────────────

export interface WhiteboardRuntime {
    objects: SdkObjectStore;
    keys: WhiteboardKeys;
    sessions: Sessions;
    cipherFor(workspaceId: number): SdkCipher;
    /** L'offre du propriétaire de CET espace : une image dans un tableau projeté pèse chez lui. */
    quotaFor(workspaceId: number): SdkQuota;
    /** La phrase à dire quand le stockage ne garderait pas les images, sinon `null`. */
    storageProblem(): Promise<string | null>;
}

let runtime: WhiteboardRuntime | null = null;

export function setRuntime(next: WhiteboardRuntime | null): void {
    runtime = next;
}

export function whiteboard(): WhiteboardRuntime {
    if (runtime === null) throw new FeatureError('internal', 'Tableau blanc : service non démarré');
    return runtime;
}

export function untitled(title: string): string {
    return title.trim() || 'Sans titre';
}
