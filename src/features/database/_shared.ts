import { createHash } from 'crypto';
import type { Database, DatabaseAlert, DatabaseAlertRow, DatabaseRow } from 'deveye-types';
import { databaseAlertSchema, databaseSchema } from 'deveye-types';
import type { Cipher } from '@/Services/SecureStore';
import type { DatabaseWithStatsRow } from '@/db/repos/database';
import type { StoredAccess, StoredAlert, StoredDatabase } from '@/Services/DatabaseMonitor';
import { FeatureError, type FeatureContext } from '../_define';

/**
 * Le socle de la feature Bases de données.
 *
 * **Un seul chiffre, toujours l'étage ouvert.** Une base appartient à l'espace
 * et peut servir plusieurs projets de paliers différents ; elle ne peut donc
 * suivre aucun d'eux. Corollaire pratique : rien ici ne demande jamais de mot de
 * passe, et le relevé périodique lit tout sans session — ce qui est exactement
 * ce dont il a besoin.
 *
 * **Aucun secret ne sort.** Ni le mot de passe de la base, ni celui du tunnel :
 * les DTO n'en portent qu'un booléen. C'est la même discipline que les jetons
 * d'accès git, et pour la même raison — un secret rendu au client est un secret
 * qu'on ne peut plus reprendre.
 */
export function databaseCipher(ctx: FeatureContext): Cipher {
    return ctx.secure.open;
}

/**
 * L'identité d'une base dans l'espace.
 *
 * Le chiffrement étant non déterministe, `content` ne peut porter aucune
 * contrainte d'unicité : deux chiffrés de « Prod » diffèrent. Ce condensé la
 * porte à sa place — même motif que `slugRef` pour un dépôt git.
 */
export function nameRef(name: string): string {
    return createHash('sha256').update(name.trim().toLowerCase()).digest('hex').slice(0, 16);
}

/** Déchiffre et parse, sans jamais lever : `null` dit simplement « illisible ». */
export async function readJson<T>(cipher: Cipher, blob: string | null): Promise<T | null> {
    if (!blob) return null;
    const plain = await cipher.tryDecrypt(blob);
    if (plain === null) return null;
    try {
        return JSON.parse(plain) as T;
    } catch {
        return null;
    }
}

/**
 * Charge une base de l'espace actif, ou lève `not_found`.
 *
 * C'est **la** frontière d'espace de la feature : toute commande qui prend un
 * `databaseId` commence par là, sans quoi elle répondrait sur la base d'autrui.
 */
export async function loadDatabase(ctx: FeatureContext, databaseId: number): Promise<DatabaseRow> {
    const row = await ctx.db.databases.find(databaseId, ctx.workspaceId);
    if (!row) throw new FeatureError('not_found', 'Base de données introuvable');
    return row;
}

export async function toDatabase(cipher: Cipher, row: DatabaseWithStatsRow): Promise<Database> {
    const body = await readJson<Partial<StoredDatabase>>(cipher, row.content);
    const access = await readJson<Partial<StoredAccess>>(cipher, row.access_content);
    return databaseSchema.parse({
        id: row.id,
        engine: row.engine === 'postgres' ? 'postgres' : 'mysql',
        name: body?.name ?? '',
        host: body?.host ?? '',
        port: body?.port ?? 3306,
        database: body?.database ?? '',
        username: body?.username ?? '',
        // Le booléen, jamais le secret.
        hasPassword: row.secret_enc !== null && row.secret_enc !== '',
        access: {
            kind: access?.kind ?? 'direct',
            host: access?.host ?? '',
            port: access?.port ?? null,
            username: access?.username ?? '',
            auth: access?.auth ?? 'password',
            hasSecret: row.access_secret_enc !== null && row.access_secret_enc !== ''
        },
        monitorEnabled: row.monitor_enabled === 1,
        intervalSeconds: row.interval_seconds,
        autoLoadTables: body?.autoLoadTables === true,
        lastCheckAt: row.last_check_at,
        lastElapsedMs: row.last_elapsed_ms === null ? null : Number(row.last_elapsed_ms),
        status: row.status === 'up' || row.status === 'down' ? row.status : 'unknown',
        lastError: row.last_error ? await cipher.tryDecrypt(row.last_error) : null,
        serverVersion: row.server_version,
        sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
        tableCount: row.table_count === null ? null : Number(row.table_count),
        alertCount: row.alert_count,
        firingCount: row.firing_count,
        projectCount: row.project_count,
        created: row.created
    });
}

export async function toAlert(cipher: Cipher, row: DatabaseAlertRow): Promise<DatabaseAlert> {
    const body = await readJson<Partial<StoredAlert>>(cipher, row.content);
    return databaseAlertSchema.parse({
        id: row.id,
        databaseId: row.database_id,
        name: body?.name ?? '',
        enabled: row.enabled === 1,
        combinator: row.combinator === 'or' ? 'or' : 'and',
        conditions: body?.conditions ?? [],
        message: body?.message ?? '',
        firing: row.firing === 1,
        lastCheckAt: row.last_check_at,
        lastFiredAt: row.last_fired_at,
        lastValues: body?.lastValues ?? [],
        lastError: row.last_error ? await cipher.tryDecrypt(row.last_error) : null,
        created: row.created
    });
}

/**
 * Recharge une base avec ses compteurs, pour la rendre au client.
 *
 * Une requête de plus après chaque écriture, assumée : sans elle, le nombre de
 * projets et d'alertes serait absent ou deviné, et la liste afficherait « 0
 * projet » sur une base qui en sert trois — un chiffre faux est pire qu'un
 * aller-retour.
 */
export async function reloadDatabase(ctx: FeatureContext, databaseId: number): Promise<Database> {
    const row = await ctx.db.databases.findWithStats(databaseId, ctx.workspaceId);
    if (!row) throw new FeatureError('not_found', 'Base de données introuvable');
    return toDatabase(databaseCipher(ctx), row);
}

/** Le service de relevé, ou une erreur claire s'il n'est pas monté (tests). */
export function monitorOf(ctx: FeatureContext) {
    if (!ctx.databases) throw new FeatureError('internal', 'Service de surveillance des bases indisponible');
    return ctx.databases;
}

export const READ = { feature: 'database' } as const;
export const WRITE = { feature: 'database', level: 'write' } as const;
