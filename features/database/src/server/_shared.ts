import { createHash } from 'crypto';
import type {
    Database,
    DatabaseAlert,
    DatabaseAlertRow,
    DatabaseCondition,
    DatabaseRow,
    DatabaseUsage
} from '../contracts/domain';
import { databaseAlertSchema, databaseSchema } from '../contracts/domain';
import { PROJECTS_USAGE_PROVIDER, type ProjectsUsageProvider } from '@deveye/types/sdk';
import { FeatureError, type SdkCipher, type SdkFeatureContext } from '@deveye/types/sdk/server';

import type { DatabaseRepo, DatabaseWithStatsRow } from './repo';
import type { DatabaseMonitor } from './service';
import type { TunnelConfig } from './tunnel';

/**
 * Le socle de la feature : un seul chiffre, toujours l'étage ouvert (une base
 * appartient à l'espace, le relevé périodique lit tout sans session), et aucun
 * secret ne sort, les DTO n'en portent qu'un booléen.
 */

/** Le contexte du SDK, sur le dépôt du module. */
export type Ctx = SdkFeatureContext<DatabaseRepo>;

/** Ce que porte `database_alerts.content`, chiffré. */
export interface StoredAlert {
    name: string;
    conditions: DatabaseCondition[];
    message: string;
    /** Ce qu'a mesuré la dernière évaluation, condition par condition. */
    lastValues: (number | null)[];
}

/** Ce que porte `database_connections.content`, chiffré. */
export interface StoredDatabase {
    name: string;
    host: string;
    port: number;
    database: string;
    username: string;
    /** Dans le blob et non en colonne : un réglage d'affichage, qui n'entre dans aucune requête. */
    autoLoadTables?: boolean;
}

/** Ce que porte `database_connections.access_content`, chiffré. */
export interface StoredAccess {
    kind: TunnelConfig['kind'];
    host: string;
    port: number | null;
    username: string;
    auth: TunnelConfig['auth'];
    /** En mode `device`, l'appareil, et le membre dont le droit le couvre. */
    deviceId?: string | null;
    authorUserId?: number | null;
}

/**
 * Ce que disent les chemins sans session (relevé, mesure pour Projets, accès pour
 * Sauvegardes) d'une base que l'offre tient en pause : une commande, elle, lève
 * par `ctx.quota.assertActive`, que l'écran sait expliquer.
 */
export const PLAN_PAUSED_MESSAGE = 'Au-delà de l’offre : cette base est en pause.';

/** Le service de relevé, posé par `createService` au démarrage : un singleton par processus. */
let monitorRef: DatabaseMonitor | null = null;

export function setMonitor(monitor: DatabaseMonitor | null): void {
    monitorRef = monitor;
}

/** Le service de relevé, ou une erreur claire s'il n'est pas monté (tests). */
export function monitorOf(): DatabaseMonitor {
    if (!monitorRef) throw new FeatureError('internal', 'Service de surveillance des bases indisponible');
    return monitorRef;
}

/**
 * L'identité d'une base dans l'espace : le chiffrement étant non déterministe,
 * `content` ne peut porter l'unicité, ce condensé la porte à sa place.
 */
export function nameRef(name: string): string {
    return createHash('sha256').update(name.trim().toLowerCase()).digest('hex').slice(0, 16);
}

/** Déchiffre et parse, sans jamais lever : `null` dit simplement « illisible ». */
export async function readJson<T>(cipher: SdkCipher, blob: string | null): Promise<T | null> {
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
 * Une base visible depuis cet espace (la sienne ou projetée), ou `not_found`.
 * Toute commande qui prend un `databaseId` commence par là ; `ctx.items.assert`
 * refuse en plus ce qu'une restriction de rôle masque ou passe en lecture seule.
 */
export async function loadDatabase(
    ctx: Ctx,
    databaseId: number,
    level: 'read' | 'write' = 'read'
): Promise<DatabaseRow> {
    const row = await ctx.repo.findVisible(databaseId, ctx.workspaceId);
    if (!row) throw new FeatureError('not_found', 'Base de données introuvable');
    await ctx.items.assert(String(databaseId), level);
    return row;
}

/** Le codec d'une base là où elle vit : une base projetée reste chiffrée sous la clé de son domicile. */
export async function databaseCipherFor(ctx: Ctx, row: Pick<DatabaseRow, 'id' | 'workspace_id'>): Promise<SdkCipher> {
    if (row.workspace_id === ctx.workspaceId) return ctx.cipher();
    const scope = await ctx.sharing.scope();
    return scope.cipherFor(String(row.id));
}

/** Le contrat de Projets ; absent, zéro projet partout et aucune commande ne casse. */
export function projectsProvider(ctx: Pick<Ctx, 'providers'>): ProjectsUsageProvider | undefined {
    return ctx.providers.get<ProjectsUsageProvider>(PROJECTS_USAGE_PROVIDER);
}

/** Combien de projets de l'espace appelant relient chaque base (le module ne lit aucune table de Projets). */
export async function projectCountsOf(ctx: Ctx): Promise<ReadonlyMap<number, number>> {
    return (await projectsProvider(ctx)?.countByItem('database', ctx.workspaceId)) ?? new Map<number, number>();
}

/** Les projets de l'espace appelant qui relient cette base, avec leur titre. */
export async function projectUsageOf(ctx: Ctx, databaseId: number): Promise<DatabaseUsage[]> {
    const usage = (await projectsProvider(ctx)?.usageOf('database', databaseId, ctx.workspaceId)) ?? [];
    return usage.map((u) => ({ projectId: u.projectId, title: u.title, status: u.status }));
}

export async function toDatabase(
    cipher: SdkCipher,
    row: DatabaseWithStatsRow,
    foreign: boolean,
    /** Le nombre de projets qui s'en servent, venu du contrat de Projets. */
    projectCount: number,
    planPaused: boolean
): Promise<Database> {
    const body = await readJson<Partial<StoredDatabase>>(cipher, row.content);
    const access = await readJson<Partial<StoredAccess>>(cipher, row.access_content);
    return databaseSchema.parse({
        foreign,
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
            hasSecret: row.access_secret_enc !== null && row.access_secret_enc !== '',
            deviceId: access?.deviceId ?? null
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
        projectCount,
        planPaused,
        created: row.created
    });
}

export async function toAlert(cipher: SdkCipher, row: DatabaseAlertRow): Promise<DatabaseAlert> {
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

/** Recharge une base avec ses compteurs après une écriture, pour la rendre au client. */
export async function reloadDatabase(ctx: Ctx, databaseId: number): Promise<Database> {
    const row = await ctx.repo.findVisibleWithStats(databaseId, ctx.workspaceId);
    if (!row) throw new FeatureError('not_found', 'Base de données introuvable');
    const counts = await projectCountsOf(ctx);
    return toDatabase(
        await databaseCipherFor(ctx, row),
        row,
        row.workspace_id !== ctx.workspaceId,
        counts.get(databaseId) ?? 0,
        ctx.quota.isPaused('connections', String(databaseId))
    );
}
