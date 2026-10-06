import type { FeatureSealedColumn } from '@deveye/types/sdk/server';

import type { Queryable } from '@/db/pool';
import { moduleSealLabel, SEAL_VERSION, type SealLabel } from './Encryption';
import { totpContext, userDekContext, userOpenDekContext, workspaceDekContext } from './sealContexts';

/**
 * Une colonne que la clé serveur scelle : avec quelle étiquette, et sous quel
 * contexte. La rotation, le re-scellement et le contrôle au boot lisent tous
 * {@link sealTargets} : une colonne qui n'y figure pas deviendrait illisible à
 * la première rotation.
 */
export interface SealTarget {
    table: string;
    column: string;
    /** La colonne qui identifie une ligne à elle seule. */
    id: string;
    /** Restreint aux lignes emballées par la clé serveur, quand la table en mêle d'autres. */
    match?: Readonly<Record<string, string>>;
    label: SealLabel;
    context: (id: string | number) => string;
}

/** Celles du socle. Un module déclare les siennes (`FeatureServer.sealed`). */
export const CORE_SEAL_TARGETS: readonly SealTarget[] = [
    {
        table: 'user_secret_keys',
        column: 'dek_wrapped',
        id: 'user_id',
        match: { wrap_mode: 'server' },
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
    { table: 'user_2fa', column: 'secret_enc', id: 'user_id', label: 'totp', context: (id) => totpContext(Number(id)) }
];

interface SealingModule {
    manifest: { id: string };
    server: { sealed?: readonly FeatureSealedColumn[] };
}

/** Celles du socle, puis celles que déclarent les modules installés, sous leur étiquette. */
export function sealTargets(modules: readonly SealingModule[]): SealTarget[] {
    return [
        ...CORE_SEAL_TARGETS,
        ...modules.flatMap(({ manifest, server }) =>
            (server.sealed ?? []).map((sealed) => ({
                table: sealed.table,
                column: sealed.column,
                id: sealed.id,
                match: sealed.match,
                label: moduleSealLabel(manifest.id),
                context: sealed.context ?? (() => '')
            }))
        )
    ];
}

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
    const match = Object.entries(t.match ?? {});
    const r = await q.query<SealedRow>(
        `SELECT ${t.id} AS id, ${t.column} AS enc FROM ${t.table}
         WHERE ${t.column} IS NOT NULL AND ${t.column} <> ''${match.map(([column]) => ` AND ${column} = ?`).join('')}`,
        match.map(([, value]) => value)
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
