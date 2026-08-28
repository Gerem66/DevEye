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
 * Le socle de la feature Bases de données.
 *
 * **Un seul chiffre, toujours l'étage ouvert.** Une base appartient à l'espace
 * et peut servir plusieurs projets de paliers différents ; elle ne peut donc
 * suivre aucun d'eux. Corollaire pratique : rien ici ne demande jamais de mot de
 * passe, et le relevé périodique lit tout sans session — ce qui est exactement
 * ce dont il a besoin. `ctx.cipher()` est cet étage (l'ex `ctx.secure.open`).
 *
 * **Aucun secret ne sort.** Ni le mot de passe de la base, ni celui du tunnel :
 * les DTO n'en portent qu'un booléen. C'est la même discipline que les jetons
 * d'accès git, et pour la même raison — un secret rendu au client est un secret
 * qu'on ne peut plus reprendre.
 */

/** Le contexte d'une commande de Bases de données : le contexte du SDK, sur le dépôt du module. */
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
    /**
     * Charger les tables à l'ouverture de la fiche.
     *
     * Ici et non dans une colonne : c'est un réglage d'affichage, il n'entre
     * dans aucune requête et ne se trie sur rien. Le blob chiffré est fait pour
     * ça, et l'ajouter n'a donc coûté aucune migration.
     */
    autoLoadTables?: boolean;
}

/** Ce que porte `database_connections.access_content`, chiffré. */
export interface StoredAccess {
    kind: TunnelConfig['kind'];
    host: string;
    port: number | null;
    username: string;
    auth: TunnelConfig['auth'];
}

/**
 * Le service de relevé du module, posé par `createService` au démarrage : le
 * remplaçant du `ctx.databases` natif. Un singleton d'étendue module, assumé
 * (patron `setEngine` de CloudSync) : le relevé est unique par processus,
 * exactement comme avant le rapatriement.
 */
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
 * Charge une base de l'espace actif, ou lève `not_found`.
 *
 * C'est **la** frontière d'espace de la feature : toute commande qui prend un
 * `databaseId` commence par là, sans quoi elle répondrait sur la base d'autrui.
 */
/**
 * Une base visible depuis cet espace — la sienne, ou une qu'on y projette.
 *
 * `level` décide de la garde : `ctx.items.assert` (l'ex `assertItem`) refuse
 * en plus les bases qu'une restriction de rôle masque ou passe en lecture
 * seule.
 */
export async function loadDatabase(
    ctx: Ctx,
    databaseId: number,
    level: 'read' | 'write' = 'read'
): Promise<DatabaseRow> {
    const row = await ctx.repo.findVisible(databaseId, ctx.workspaceId);
    if (!row) throw new FeatureError('not_found', 'Base de données introuvable');
    await ctx.items.assert(databaseId, level);
    return row;
}

/**
 * Le codec d'une base **là où elle vit**.
 *
 * Une base projetée reste chiffrée sous la clé de son espace d'origine : la
 * déchiffrer avec celle d'ici rendrait un nom vide et une cible illisible — une
 * base qu'on croirait mal enregistrée plutôt qu'une base d'ailleurs.
 * `ctx.sharing.scope()` est l'ex `shareScope(ctx, 'database')`.
 */
export async function databaseCipherFor(ctx: Ctx, row: Pick<DatabaseRow, 'id' | 'workspace_id'>): Promise<SdkCipher> {
    if (row.workspace_id === ctx.workspaceId) return ctx.cipher();
    const scope = await ctx.sharing.scope();
    return scope.cipherFor(row.id);
}

/**
 * Le contrat de Projets, relu à l'appel : offert par l'app tant que Projets
 * est native, par son module ensuite ; d'ici, aucune différence. Absent (rien
 * n'offre la clé), la feature dégrade proprement : zéro projet partout, aucune
 * commande ne casse.
 */
export function projectsProvider(ctx: Pick<Ctx, 'providers'>): ProjectsUsageProvider | undefined {
    return ctx.providers.get<ProjectsUsageProvider>(PROJECTS_USAGE_PROVIDER);
}

/**
 * Combien de projets de l'espace **appelant** relient chaque base.
 *
 * Le module ne lit aucune table de Projets : le compte vient de son contrat,
 * et les projets comptés sont ceux d'ICI, les mêmes que `database.get` liste
 * (une base projetée montre les projets de la fenêtre, pas ceux de son
 * domicile).
 */
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
    projectCount: number
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
        projectCount,
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

/**
 * Recharge une base avec ses compteurs, pour la rendre au client.
 *
 * Une requête de plus après chaque écriture, assumée : sans elle, le nombre de
 * projets et d'alertes serait absent ou deviné, et la liste afficherait « 0
 * projet » sur une base qui en sert trois — un chiffre faux est pire qu'un
 * aller-retour.
 */
export async function reloadDatabase(ctx: Ctx, databaseId: number): Promise<Database> {
    const row = await ctx.repo.findVisibleWithStats(databaseId, ctx.workspaceId);
    if (!row) throw new FeatureError('not_found', 'Base de données introuvable');
    const counts = await projectCountsOf(ctx);
    return toDatabase(
        await databaseCipherFor(ctx, row),
        row,
        row.workspace_id !== ctx.workspaceId,
        counts.get(databaseId) ?? 0
    );
}
