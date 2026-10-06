import type { Queryable } from '@/db/pool';
import { SEAL_VERSION, type SealLabel } from './Encryption';
import { totpContext, userDekContext, userOpenDekContext, workspaceDekContext } from './sealContexts';

/**
 * Chaque colonne que la clé serveur scelle : avec quelle étiquette, et sous quel
 * contexte. La rotation, le re-scellement et le contrôle au boot lisent tous
 * cette liste : une colonne oubliée ici deviendrait illisible à la première
 * rotation. Un module qui scelle du matériel ajoute sa ligne (son contexte est
 * celui qu'il passe à `keys.sealBytes`, vide s'il n'en passe pas).
 */
export interface SealTarget {
    table: string;
    column: string;
    /** La colonne qui identifie une ligne à elle seule. */
    id: string;
    /** Restreint aux lignes emballées par la clé serveur, quand la table en mêle d'autres. */
    where?: string;
    label: SealLabel;
    context: (id: string | number) => string;
}

const noContext = (): string => '';

export const SEAL_TARGETS: SealTarget[] = [
    {
        table: 'user_secret_keys',
        column: 'dek_wrapped',
        id: 'user_id',
        where: "wrap_mode = 'server'",
        label: 'user-dek',
        context: (id) => userDekContext(Number(id))
    },
    {
        table: 'user_secret_keys',
        column: 'open_dek_wrapped',
        id: 'user_id',
        label: 'user-open-dek',
        context: (id) => userOpenDekContext(Number(id))
    },
    {
        table: 'workspace_secret_keys',
        column: 'dek_wrapped',
        id: 'workspace_id',
        label: 'workspace-dek',
        context: (id) => workspaceDekContext(Number(id))
    },
    { table: 'user_2fa', column: 'secret_enc', id: 'user_id', label: 'totp', context: (id) => totpContext(Number(id)) },
    // CloudSync : la BMK.
    {
        table: 'sync_meta',
        column: 'v',
        id: 'k',
        where: "k = 'blob_key_wrapped'",
        label: 'module:cloudsync',
        context: noContext
    },
    // Serveur mail : la clé des corps de chaque boîte, les clés DKIM des domaines,
    // et la clé du certificat des écouteurs.
    { table: 'ft_mailserver_mailboxes', column: 'blob_key', id: 'id', label: 'module:mailserver', context: noContext },
    {
        table: 'ft_mailserver_domain_keys',
        column: 'private_key',
        id: 'id',
        label: 'module:mailserver',
        context: noContext
    },
    { table: 'ft_mailserver_tls', column: 'sealed', id: 'id', label: 'module:mailserver', context: noContext },
    // Hébergement : la racine des clés du module (fichiers, noms, accès), et les signalements.
    {
        table: 'ft_hosting_key',
        column: 'sealed',
        id: 'id',
        label: 'module:x-hosting',
        context: () => 'ft_hosting_key:sealed'
    },
    {
        table: 'ft_hosting_reports',
        column: 'content',
        id: 'ref',
        label: 'module:x-hosting',
        context: (id) => `ft_hosting_reports:content:${id}`
    }
];

export interface SealedRow {
    id: string | number;
    enc: string;
}

export async function tableExists(q: Queryable, table: string): Promise<boolean> {
    const r = await q.query<{ n: number }>(
        'SELECT COUNT(*) n FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
        [table]
    );
    return Number(r.rows[0]?.n ?? 0) > 0;
}

/** Les lignes scellées d'une cible (vide si la table n'existe pas : module non installé). */
export async function sealedRows(q: Queryable, t: SealTarget): Promise<SealedRow[] | null> {
    if (!(await tableExists(q, t.table))) return null;
    const r = await q.query<SealedRow>(
        `SELECT ${t.id} AS id, ${t.column} AS enc FROM ${t.table}
         WHERE ${t.column} IS NOT NULL AND ${t.column} <> ''${t.where ? ` AND ${t.where}` : ''}`,
        []
    );
    return r.rows;
}

/** L'octet de version d'un blob scellé ; `null` s'il est vide ou illisible. */
export function sealVersionOf(blob: string): number | null {
    const decoded = Buffer.from(blob, 'base64');
    return decoded.length === 0 ? null : decoded[0];
}

export function isCurrentSealFormat(blob: string): boolean {
    return sealVersionOf(blob) === SEAL_VERSION;
}
