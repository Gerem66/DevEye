import { z } from 'zod';
import {
    DATABASE_ALERT_MESSAGE_MAX_LENGTH,
    DATABASE_ALERT_NAME_MAX_LENGTH,
    DATABASE_HOST_MAX_LENGTH,
    DATABASE_NAME_MAX_LENGTH,
    DATABASE_SECRET_MAX_LENGTH,
    DATABASE_SQL_MAX_LENGTH,
    DATABASE_USER_MAX_LENGTH,
    databaseAccessKindSchema,
    databaseAlertSchema,
    databaseCellSchema,
    databaseCombinatorSchema,
    databaseConditionSchema,
    databaseDeviceSchema,
    databaseEngineSchema,
    databaseExecutionSchema,
    databaseExportFormatSchema,
    databaseFilterSchema,
    databaseIdRangeSchema,
    databaseProbeSchema,
    databaseRowsSchema,
    databaseSchema,
    databaseSortSchema,
    databaseSshAuthSchema,
    databaseStructureSchema,
    databaseTableSchema,
    databaseUsageSchema
} from './domain';

/**
 * Commandes des bases de données de l'espace, préfixe `database.` en camelCase.
 *
 * Piège : le filet de démarrage (`MUTATION_VERB` dans `src/features/_topics.ts`)
 * cherche un verbe juste après le point et ne verra aucune de ces commandes ;
 * un `mutates` oublié ne produit aucun avertissement.
 *
 * Seules les commandes qui lisent ou écrivent chez le serveur joignent la base,
 * sur un geste explicite ; `list` et `get` lisent le cache local. L'espace visé
 * voyage sur l'enveloppe WS, jamais en entrée.
 */

const databaseId = z.number().int().positive();
const alertId = z.number().int().positive();

/** La partie réglable d'un accès, secret compris (jamais rendu en retour). */
const accessInput = z.object({
    kind: databaseAccessKindSchema,
    host: z.string().max(DATABASE_HOST_MAX_LENGTH),
    port: z.number().int().min(1).max(65535).nullable(),
    username: z.string().max(DATABASE_USER_MAX_LENGTH),
    auth: databaseSshAuthSchema,
    deviceId: z.uuid().nullable(),
    /**
     * Mot de passe SSH ou clé privée. Absent = on garde celui en place ; une
     * chaîne vide l'efface. Le client ne le reçoit jamais.
     */
    secret: z.string().max(DATABASE_SECRET_MAX_LENGTH).optional()
});

/** Le nombre de bases de l'espace, pour la tuile de l'accueil. */
export const databaseCount = {
    command: 'database.count' as const,
    input: z.object({}),
    output: z.object({ count: z.number().int().nonnegative() })
};

/** Dans l'ordre de l'utilisateur ; lit le cache local. */
export const databaseList = {
    command: 'database.list' as const,
    input: z.object({}),
    output: z.object({ databases: z.array(databaseSchema) })
};

export const databaseGet = {
    command: 'database.get' as const,
    input: z.object({ databaseId }),
    output: z.object({
        database: databaseSchema,
        usage: z.array(databaseUsageSchema),
        alerts: z.array(databaseAlertSchema)
    })
};

export const databaseAdd = {
    command: 'database.add' as const,
    input: z.object({
        engine: databaseEngineSchema,
        name: z.string().min(1).max(DATABASE_NAME_MAX_LENGTH),
        host: z.string().min(1).max(DATABASE_HOST_MAX_LENGTH),
        port: z.number().int().min(1).max(65535),
        database: z.string().min(1).max(DATABASE_NAME_MAX_LENGTH),
        username: z.string().max(DATABASE_USER_MAX_LENGTH),
        password: z.string().max(DATABASE_SECRET_MAX_LENGTH),
        access: accessInput,
        monitorEnabled: z.boolean(),
        intervalSeconds: z.number().int().min(60).max(86400),
        autoLoadTables: z.boolean()
    }),
    output: z.object({ database: databaseSchema })
};

/** `password` absent = on garde celui en place ; une chaîne vide l'efface. */
export const databaseUpdate = {
    command: 'database.update' as const,
    input: z.object({
        databaseId,
        name: z.string().min(1).max(DATABASE_NAME_MAX_LENGTH),
        host: z.string().min(1).max(DATABASE_HOST_MAX_LENGTH),
        port: z.number().int().min(1).max(65535),
        database: z.string().min(1).max(DATABASE_NAME_MAX_LENGTH),
        username: z.string().max(DATABASE_USER_MAX_LENGTH),
        password: z.string().max(DATABASE_SECRET_MAX_LENGTH).optional(),
        access: accessInput,
        monitorEnabled: z.boolean(),
        intervalSeconds: z.number().int().min(60).max(86400),
        autoLoadTables: z.boolean()
    }),
    output: z.object({ database: databaseSchema })
};

/** Les appareils de l'espace par lesquels joindre une base, pour le formulaire d'accès. */
export const databaseDevices = {
    command: 'database.devices' as const,
    input: z.object({}),
    output: z.object({ devices: z.array(databaseDeviceSchema) })
};

/** Retire la base, ses alertes et ses liaisons ; les projets liés ne perdent que leur base. */
export const databaseRemove = {
    command: 'database.remove' as const,
    input: z.object({ databaseId }),
    output: z.object({ databaseId })
};

/** `ids` est la liste complète dans son ordre final. */
export const databaseReorder = {
    command: 'database.reorder' as const,
    input: z.object({ ids: z.array(databaseId).min(1) }),
    output: z.object({ ids: z.array(databaseId) })
};

/** Ne lève jamais sur un échec de connexion : le message revient dans `error`. */
export const databaseTest = {
    command: 'database.test' as const,
    input: z.object({ databaseId }),
    output: z.object({ probe: databaseProbeSchema })
};

/**
 * Essaie des réglages pas encore enregistrés, sans rien écrire. `databaseId`
 * sert à la modification : un secret laissé intact ne redescend jamais au
 * client, le serveur reprend alors celui qu'il détient.
 */
export const databaseTestDraft = {
    command: 'database.testDraft' as const,
    input: z.object({
        databaseId: databaseId.optional(),
        engine: databaseEngineSchema,
        host: z.string().min(1).max(DATABASE_HOST_MAX_LENGTH),
        port: z.number().int().min(1).max(65535),
        database: z.string().min(1).max(DATABASE_NAME_MAX_LENGTH),
        username: z.string().max(DATABASE_USER_MAX_LENGTH),
        password: z.string().max(DATABASE_SECRET_MAX_LENGTH).optional(),
        access: accessInput
    }),
    output: z.object({ probe: databaseProbeSchema })
};

/** Le relevé périodique, sur demande : inventaire et alertes, même sur une base au repos. */
export const databaseInspect = {
    command: 'database.inspect' as const,
    input: z.object({ databaseId }),
    output: z.object({ database: databaseSchema, probe: databaseProbeSchema })
};

/** Les tables de la base, lues chez le serveur au moment de la demande. */
export const databaseTableList = {
    command: 'database.tableList' as const,
    input: z.object({ databaseId }),
    output: z.object({ tables: z.array(databaseTableSchema) })
};

/**
 * Table, colonnes et sens du tri sont confrontés au catalogue réel avant d'être
 * cités ; les valeurs sont toujours liées. `withStructure` rend la structure
 * dans la même session (chaque connexion peut rouvrir un tunnel SSH).
 */
export const databaseTableRows = {
    command: 'database.tableRows' as const,
    input: z.object({
        databaseId,
        schema: z.string().max(DATABASE_NAME_MAX_LENGTH),
        table: z.string().min(1).max(DATABASE_NAME_MAX_LENGTH),
        offset: z.number().int().nonnegative().max(1_000_000).optional(),
        limit: z.number().int().positive().max(200).optional(),
        filters: z.array(databaseFilterSchema).max(8).optional(),
        combinator: databaseCombinatorSchema.optional(),
        sort: databaseSortSchema.optional(),
        withStructure: z.boolean().optional()
    }),
    output: z.object({ rows: databaseRowsSchema, structure: databaseStructureSchema.optional() })
};

/** La structure seule : colonnes, clé primaire, clés étrangères, index. */
export const databaseTableStructure = {
    command: 'database.tableStructure' as const,
    input: z.object({
        databaseId,
        schema: z.string().max(DATABASE_NAME_MAX_LENGTH),
        table: z.string().min(1).max(DATABASE_NAME_MAX_LENGTH)
    }),
    output: z.object({ structure: databaseStructureSchema })
};

/**
 * Modifier ou supprimer exige une clé primaire : sans elle, rien ne désigne une
 * ligne. Le compte saisi pour la base décide en dernier ressort.
 */
export const databaseRowInsert = {
    command: 'database.rowInsert' as const,
    input: z.object({
        databaseId,
        schema: z.string().max(DATABASE_NAME_MAX_LENGTH),
        table: z.string().min(1).max(DATABASE_NAME_MAX_LENGTH),
        values: z.array(databaseCellSchema).min(1).max(200)
    }),
    output: z.object({ inserted: z.number().int().nonnegative() })
};

export const databaseRowUpdate = {
    command: 'database.rowUpdate' as const,
    input: z.object({
        databaseId,
        schema: z.string().max(DATABASE_NAME_MAX_LENGTH),
        table: z.string().min(1).max(DATABASE_NAME_MAX_LENGTH),
        /** La ligne visée, par ses colonnes de clé primaire. */
        key: z.array(databaseCellSchema).min(1).max(16),
        values: z.array(databaseCellSchema).min(1).max(200)
    }),
    output: z.object({ updated: z.number().int().nonnegative() })
};

export const databaseRowDelete = {
    command: 'database.rowDelete' as const,
    input: z.object({
        databaseId,
        schema: z.string().max(DATABASE_NAME_MAX_LENGTH),
        table: z.string().min(1).max(DATABASE_NAME_MAX_LENGTH),
        /** Une entrée par ligne, chacune par ses colonnes de clé primaire. */
        keys: z.array(z.array(databaseCellSchema).min(1).max(16)).min(1).max(200)
    }),
    output: z.object({ deleted: z.number().int().nonnegative() })
};

/**
 * Une instruction libre, écriture comprise (le terminal). Une seule à la fois :
 * le point-virgule interne est refusé.
 */
export const databaseExecute = {
    command: 'database.execute' as const,
    input: z.object({ databaseId, sql: z.string().min(1).max(DATABASE_SQL_MAX_LENGTH) }),
    output: z.object({ result: databaseExecutionSchema })
};

/**
 * Export complet, page par page ; seul un garde-fou mémoire du serveur peut
 * tronquer, et `truncated` le dit. `idRanges` borne la clé primaire, sur une
 * seule table.
 */
export const databaseExport = {
    command: 'database.export' as const,
    input: z.object({
        databaseId,
        format: databaseExportFormatSchema,
        /** Absents : toute la base. Présents : cette table seule. */
        schema: z.string().max(DATABASE_NAME_MAX_LENGTH).optional(),
        table: z.string().min(1).max(DATABASE_NAME_MAX_LENGTH).optional(),
        /** Plages d'identifiants, bornes comprises. Sans effet sans `table`. */
        idRanges: z.array(databaseIdRangeSchema).max(64).optional()
    }),
    output: z.object({
        filename: z.string(),
        content: z.string(),
        rowCount: z.number().int().nonnegative(),
        tableCount: z.number().int().nonnegative(),
        /** Le plafond a été atteint : ce qui suit manque. */
        truncated: z.boolean()
    })
};

export const databaseAlertList = {
    command: 'database.alertList' as const,
    input: z.object({ databaseId }),
    output: z.object({ alerts: z.array(databaseAlertSchema) })
};

export const databaseAlertAdd = {
    command: 'database.alertAdd' as const,
    input: z.object({
        databaseId,
        name: z.string().min(1).max(DATABASE_ALERT_NAME_MAX_LENGTH),
        enabled: z.boolean(),
        combinator: databaseCombinatorSchema,
        conditions: z.array(databaseConditionSchema).min(1).max(8),
        message: z.string().min(1).max(DATABASE_ALERT_MESSAGE_MAX_LENGTH)
    }),
    output: z.object({ alert: databaseAlertSchema })
};

export const databaseAlertUpdate = {
    command: 'database.alertUpdate' as const,
    input: z.object({
        alertId,
        name: z.string().min(1).max(DATABASE_ALERT_NAME_MAX_LENGTH),
        enabled: z.boolean(),
        combinator: databaseCombinatorSchema,
        conditions: z.array(databaseConditionSchema).min(1).max(8),
        message: z.string().min(1).max(DATABASE_ALERT_MESSAGE_MAX_LENGTH)
    }),
    output: z.object({ alert: databaseAlertSchema })
};

export const databaseAlertRemove = {
    command: 'database.alertRemove' as const,
    input: z.object({ alertId }),
    output: z.object({ alertId })
};

/** Évalue des conditions tout de suite, sans rien enregistrer ni notifier. */
export const databaseAlertTest = {
    command: 'database.alertTest' as const,
    input: z.object({
        databaseId,
        combinator: databaseCombinatorSchema,
        conditions: z.array(databaseConditionSchema).min(1).max(8)
    }),
    output: z.object({
        firing: z.boolean(),
        values: z.array(z.number().nullable()),
        /** L'erreur de chaque condition, à sa place ; `null` si elle a abouti. */
        errors: z.array(z.string().nullable()),
        elapsedMs: z.number().int().nonnegative()
    })
};

/** Une requête libre en lecture seule, pour mettre au point une condition. */
export const databaseQuery = {
    command: 'database.query' as const,
    input: z.object({ databaseId, sql: z.string().min(1).max(DATABASE_SQL_MAX_LENGTH) }),
    output: z.object({ rows: databaseRowsSchema })
};

export const databaseCommands = [
    databaseCount,
    databaseList,
    databaseGet,
    databaseAdd,
    databaseUpdate,
    databaseDevices,
    databaseRemove,
    databaseReorder,
    databaseTest,
    databaseTestDraft,
    databaseInspect,
    databaseTableList,
    databaseTableRows,
    databaseTableStructure,
    databaseRowInsert,
    databaseRowUpdate,
    databaseRowDelete,
    databaseExecute,
    databaseExport,
    databaseAlertList,
    databaseAlertAdd,
    databaseAlertUpdate,
    databaseAlertRemove,
    databaseAlertTest,
    databaseQuery
] as const;
