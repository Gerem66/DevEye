import { z } from 'zod';
import { projectStatusSchema } from '@deveye/types';

/**
 * Les bases de données d'un espace. Une base appartient à l'espace, pas à un
 * projet, donc toujours à l'étage ouvert du chiffrement. Le mot de passe et le
 * secret du tunnel ne quittent jamais le serveur : les DTO n'en portent qu'un
 * booléen. Rien ne se connecte tout seul ; le relevé périodique s'active base
 * par base, et lui seul évalue les alertes.
 */

export const DATABASE_NAME_MAX_LENGTH = 96;
export const DATABASE_HOST_MAX_LENGTH = 255;
export const DATABASE_USER_MAX_LENGTH = 128;
export const DATABASE_SECRET_MAX_LENGTH = 8192;
export const DATABASE_ALERT_NAME_MAX_LENGTH = 96;
export const DATABASE_ALERT_MESSAGE_MAX_LENGTH = 1000;
export const DATABASE_SQL_MAX_LENGTH = 4000;

export const databaseEngineSchema = z.enum(['mysql', 'postgres']);
export type DatabaseEngine = z.infer<typeof databaseEngineSchema>;

/**
 * `direct` : le serveur joint l'hôte lui-même. `ssh` : tunnel TCP ouvert dans
 * le processus, sans binaire externe ni clé sur disque. `socks` : proxy SOCKS5.
 */
export const databaseAccessKindSchema = z.enum(['direct', 'ssh', 'socks']);
export type DatabaseAccessKind = z.infer<typeof databaseAccessKindSchema>;

export const databaseSshAuthSchema = z.enum(['password', 'key']);
export type DatabaseSshAuth = z.infer<typeof databaseSshAuthSchema>;

/** `unknown` est l'état normal d'une base jamais jointe, pas une panne. */
export const databaseStatusSchema = z.enum(['unknown', 'up', 'down']);
export type DatabaseStatus = z.infer<typeof databaseStatusSchema>;

/** Les réglages du tunnel, sans aucun secret. */
export const databaseAccessSchema = z.object({
    kind: databaseAccessKindSchema,
    /** Hôte du rebond SSH ou du proxy SOCKS ; vide en accès direct. */
    host: z.string().max(DATABASE_HOST_MAX_LENGTH),
    port: z.number().int().min(1).max(65535).nullable(),
    /** Utilisateur SSH ; vide pour un proxy SOCKS anonyme. */
    username: z.string().max(DATABASE_USER_MAX_LENGTH),
    auth: databaseSshAuthSchema,
    /** Un secret est enregistré (mot de passe ou clé privée) — jamais lequel. */
    hasSecret: z.boolean()
});
export type DatabaseAccess = z.infer<typeof databaseAccessSchema>;

export const databaseSchema = z.object({
    id: z.number().int().positive(),
    engine: databaseEngineSchema,
    /** Le nom que lui donne l'utilisateur ; porte l'unicité dans l'espace. */
    name: z.string().max(DATABASE_NAME_MAX_LENGTH),
    host: z.string().max(DATABASE_HOST_MAX_LENGTH),
    port: z.number().int().min(1).max(65535),
    /** Le nom de la base sur le serveur (`schema` chez PostgreSQL). */
    database: z.string().max(DATABASE_NAME_MAX_LENGTH),
    username: z.string().max(DATABASE_USER_MAX_LENGTH),
    /** Cet élément vient d'un autre espace, qui le projette ici. */
    foreign: z.boolean(),
    /** Un mot de passe est enregistré, jamais lequel. */
    hasPassword: z.boolean(),
    access: databaseAccessSchema,
    /** Le relevé périodique tourne-t-il ? Désactivé par défaut. */
    monitorEnabled: z.boolean(),
    /** Cadence du relevé, en secondes. Sans effet si le relevé est éteint. */
    // Le plancher de l'interface, tenu aussi par le contrat : une sonde ouvre
    // une connexion sortante, et l'API ne doit pas permettre d'en ouvrir une par seconde.
    intervalSeconds: z.number().int().min(60),
    /**
     * Charger l'inventaire des tables dès l'ouverture de la fiche. Éteint par
     * défaut : c'est le seul endroit où une connexion part sans clic.
     */
    autoLoadTables: z.boolean(),
    lastCheckAt: z.number().int().nullable(),
    /** Durée du dernier relevé en ms, tunnel compris ; renseignée même sur un échec. */
    lastElapsedMs: z.number().int().nonnegative().nullable(),
    status: databaseStatusSchema,
    /** Message du dernier échec, ou `null` après un succès. */
    lastError: z.string().nullable(),
    serverVersion: z.string().nullable(),
    sizeBytes: z.number().int().nonnegative().nullable(),
    tableCount: z.number().int().nonnegative().nullable(),
    /** Combien d'alertes sont définies, et combien sont actuellement franchies. */
    alertCount: z.number().int().nonnegative(),
    firingCount: z.number().int().nonnegative(),
    /** Combien de projets s'en servent. */
    projectCount: z.number().int().nonnegative(),
    created: z.number().int()
});
export type Database = z.infer<typeof databaseSchema>;

/** Un projet qui utilise cette base ; à l'étage ouvert, donc lisible sans session. */
export const databaseUsageSchema = z.object({
    projectId: z.number().int().positive(),
    title: z.string(),
    status: projectStatusSchema
});
export type DatabaseUsage = z.infer<typeof databaseUsageSchema>;

/** Le résultat d'un essai de connexion, à la demande. */
export const databaseProbeSchema = z.object({
    ok: z.boolean(),
    serverVersion: z.string().nullable(),
    elapsedMs: z.number().int().nonnegative(),
    /** Message clair, déjà traduit ; `null` en cas de succès. */
    error: z.string().nullable()
});
export type DatabaseProbe = z.infer<typeof databaseProbeSchema>;

/** Une table, telle que l'exploration manuelle la montre. */
export const databaseTableSchema = z.object({
    schema: z.string(),
    name: z.string(),
    /** Estimation du moteur, jamais un `COUNT(*)` ; `null` si la table n'est pas analysée. */
    rowCount: z.number().int().nonnegative().nullable(),
    sizeBytes: z.number().int().nonnegative().nullable()
});
export type DatabaseTable = z.infer<typeof databaseTableSchema>;

/**
 * Les valeurs voyagent en chaînes : un `BIGINT` dépasse le nombre sûr de
 * JavaScript, les dates diffèrent entre moteurs, un `BLOB` n'a pas de JSON.
 */
export const databaseRowsSchema = z.object({
    columns: z.array(z.string()),
    rows: z.array(z.array(z.string().nullable())),
    /** Total de lignes de la table, si le moteur a pu le donner. */
    total: z.number().int().nonnegative().nullable(),
    elapsedMs: z.number().int().nonnegative()
});
export type DatabaseRows = z.infer<typeof databaseRowsSchema>;

export const databaseColumnSchema = z.object({
    name: z.string(),
    /** Le type tel que le moteur le nomme : `varchar(255)`, `int unsigned`… */
    type: z.string(),
    nullable: z.boolean(),
    /** L'expression par défaut, telle quelle ; `null` quand il n'y en a pas. */
    default: z.string().nullable(),
    primaryKey: z.boolean(),
    /** Le moteur la remplit seul (auto-incrément, identité, colonne générée). */
    generated: z.boolean(),
    comment: z.string()
});
export type DatabaseColumn = z.infer<typeof databaseColumnSchema>;

/** `columns` et `refColumns` sont appariées par position (clé composite). */
export const databaseForeignKeySchema = z.object({
    name: z.string(),
    columns: z.array(z.string()).min(1),
    refSchema: z.string(),
    refTable: z.string(),
    refColumns: z.array(z.string()).min(1)
});
export type DatabaseForeignKey = z.infer<typeof databaseForeignKeySchema>;

/** Un index, clé primaire exclue. */
export const databaseIndexSchema = z.object({
    name: z.string(),
    columns: z.array(z.string()),
    unique: z.boolean()
});
export type DatabaseIndex = z.infer<typeof databaseIndexSchema>;

/**
 * Un seul objet pour le panneau Structure, le formulaire de ligne et la
 * navigation par clé étrangère : ils se chargent pour la même sélection.
 */
export const databaseStructureSchema = z.object({
    schema: z.string(),
    table: z.string(),
    columns: z.array(databaseColumnSchema),
    /**
     * Dans l'ordre de la clé. Vide = pas de clé primaire : aucune modification
     * ni suppression n'est alors proposée, rien ne désignant une ligne.
     */
    primaryKey: z.array(z.string()),
    foreignKeys: z.array(databaseForeignKeySchema),
    indexes: z.array(databaseIndexSchema)
});
export type DatabaseStructure = z.infer<typeof databaseStructureSchema>;

/**
 * Fermé : la recherche ne transporte jamais de SQL, le serveur choisit
 * l'opérateur ici et lie la valeur en paramètre.
 */
export const databaseFilterOperatorSchema = z.enum([
    'eq',
    'ne',
    'contains',
    'starts',
    'ends',
    'gt',
    'gte',
    'lt',
    'lte',
    'isNull',
    'notNull'
]);
export type DatabaseFilterOperator = z.infer<typeof databaseFilterOperatorSchema>;

/** Un critère de recherche. `value` est ignorée par `isNull` / `notNull`. */
export const databaseFilterSchema = z.object({
    column: z.string().min(1).max(DATABASE_NAME_MAX_LENGTH),
    operator: databaseFilterOperatorSchema,
    value: z.string().max(1000)
});
export type DatabaseFilter = z.infer<typeof databaseFilterSchema>;

/** L'ordre d'affichage demandé, colonne validée contre la table réelle. */
export const databaseSortSchema = z.object({
    column: z.string().min(1).max(DATABASE_NAME_MAX_LENGTH),
    direction: z.enum(['asc', 'desc'])
});
export type DatabaseSort = z.infer<typeof databaseSortSchema>;

/**
 * `null` est un vrai `NULL`, distinct de la chaîne vide. Le reste voyage en
 * chaîne, lié en paramètre ; le moteur convertit.
 */
export const databaseCellSchema = z.object({
    column: z.string().min(1).max(DATABASE_NAME_MAX_LENGTH),
    value: z.string().max(65535).nullable()
});
export type DatabaseCell = z.infer<typeof databaseCellSchema>;

/** Ce qu'une instruction libre a produit : des lignes, ou un décompte. */
export const databaseExecutionSchema = z.object({
    /** Le résultat d'une lecture ; `null` pour une écriture. */
    rows: databaseRowsSchema.nullable(),
    /** Le nombre de lignes touchées par une écriture ; `null` pour une lecture. */
    affected: z.number().int().nonnegative().nullable(),
    elapsedMs: z.number().int().nonnegative()
});
export type DatabaseExecution = z.infer<typeof databaseExecutionSchema>;

export const databaseExportFormatSchema = z.enum(['csv', 'json', 'sql']);
export type DatabaseExportFormat = z.infer<typeof databaseExportFormatSchema>;

/**
 * Bornes comprises. Deux nombres et non du texte : « 1-500, 900 » est analysé
 * dans le navigateur, le serveur ne reçoit que des bornes qu'il lie.
 */
export const databaseIdRangeSchema = z.object({
    from: z.number().int(),
    to: z.number().int()
});
export type DatabaseIdRange = z.infer<typeof databaseIdRangeSchema>;

export const databaseComparatorSchema = z.enum(['gt', 'gte', 'lt', 'lte', 'eq', 'ne']);
export type DatabaseComparator = z.infer<typeof databaseComparatorSchema>;

/** Une requête qui rend un seul nombre, comparée à un seuil. */
export const databaseConditionSchema = z.object({
    sql: z.string().min(1).max(DATABASE_SQL_MAX_LENGTH),
    comparator: databaseComparatorSchema,
    threshold: z.number(),
    /** Nom court de la mesure, repris dans le message ({@link databaseAlertSchema}). */
    label: z.string().max(DATABASE_ALERT_NAME_MAX_LENGTH)
});
export type DatabaseCondition = z.infer<typeof databaseConditionSchema>;

export const databaseCombinatorSchema = z.enum(['and', 'or']);
export type DatabaseCombinator = z.infer<typeof databaseCombinatorSchema>;

/**
 * Évaluée par le relevé périodique, donc seulement si celui-ci est actif sur
 * la base ; inerte sinon, et l'interface le dit.
 */
export const databaseAlertSchema = z.object({
    id: z.number().int().positive(),
    databaseId: z.number().int().positive(),
    name: z.string().max(DATABASE_ALERT_NAME_MAX_LENGTH),
    enabled: z.boolean(),
    combinator: databaseCombinatorSchema,
    conditions: z.array(databaseConditionSchema),
    /** `{label}` y est remplacé par la valeur mesurée de la condition portant ce nom. */
    message: z.string().max(DATABASE_ALERT_MESSAGE_MAX_LENGTH),
    /** Franchie en ce moment. */
    firing: z.boolean(),
    /** Dernière évaluation, et dernier déclenchement (deux dates distinctes). */
    lastCheckAt: z.number().int().nullable(),
    lastFiredAt: z.number().int().nullable(),
    /** Ce qu'a rendu la dernière évaluation, condition par condition. */
    lastValues: z.array(z.number().nullable()),
    /** Pourquoi la dernière évaluation a échoué, s'il y a lieu. */
    lastError: z.string().nullable(),
    created: z.number().int()
});
export type DatabaseAlert = z.infer<typeof databaseAlertSchema>;

/** Ligne SQL (serveur uniquement). */
export interface DatabaseRow {
    id: number;
    workspace_id: number;
    engine: string;
    /** Condensé du nom en minuscules : porte l'unicité dans l'espace. */
    name_ref: string;
    sort_order: number;
    monitor_enabled: number;
    interval_seconds: number;
    last_check_at: number | null;
    /** En ms ; renseignée aussi sur un échec. */
    last_elapsed_ms: number | null;
    status: string;
    last_error: string | null;
    server_version: string | null;
    size_bytes: number | null;
    table_count: number | null;
    /** { name, host, port, database, username } chiffré. */
    content: string;
    /** Mot de passe de la base, chiffré. Ne sort jamais du serveur. */
    secret_enc: string | null;
    /** { kind, host, port, username, auth } chiffré. */
    access_content: string | null;
    /** Mot de passe SSH ou clé privée, chiffré. Ne sort jamais du serveur. */
    access_secret_enc: string | null;
    created: number;
}

/** Ligne SQL (serveur uniquement). */
export interface DatabaseAlertRow {
    id: number;
    database_id: number;
    workspace_id: number;
    enabled: number;
    combinator: string;
    firing: number;
    last_check_at: number | null;
    last_fired_at: number | null;
    last_error: string | null;
    /** { name, conditions, message, lastValues } chiffré. */
    content: string;
    created: number;
}
