import { z } from 'zod';
import { projectStatusSchema } from '@deveye/types';

/**
 * Les bases de données d'un espace.
 *
 * Même renversement que pour les dépôts git : une base appartient à l'espace,
 * pas à un projet, et plusieurs projets peuvent pointer la même. Elle vit donc à
 * l'étage **ouvert** du chiffrement — un projet confidentiel ne peut pas en
 * lier, exactement comme pour un dépôt.
 *
 * ## Ce qui est chiffré, et ce qui ne sort jamais
 *
 * `content` porte l'adresse, le port, le nom de la base et l'identifiant, tous
 * chiffrés. Le **mot de passe** vit à part, dans sa propre colonne, et ne quitte
 * jamais le serveur : les DTO ci-dessous n'en portent qu'un `hasPassword`. Même
 * règle pour le secret du tunnel. C'est la même discipline que les jetons
 * d'accès git, et pour la même raison — un secret rendu au client est un secret
 * qu'on ne peut plus reprendre.
 *
 * ## À la demande par défaut
 *
 * Rien ne se connecte tout seul : ouvrir la feature ne joint aucune base. Le
 * relevé périodique (`monitorEnabled`) est une option, activée base par base, et
 * c'est **seulement** quand elle est active que les alertes ont un sens — il
 * faut bien que quelque chose les évalue.
 */

export const DATABASE_NAME_MAX_LENGTH = 96;
export const DATABASE_HOST_MAX_LENGTH = 255;
export const DATABASE_USER_MAX_LENGTH = 128;
export const DATABASE_SECRET_MAX_LENGTH = 8192;
export const DATABASE_ALERT_NAME_MAX_LENGTH = 96;
export const DATABASE_ALERT_MESSAGE_MAX_LENGTH = 1000;
export const DATABASE_SQL_MAX_LENGTH = 4000;

/** Les moteurs joignables. Deux dialectes, deux adaptateurs, rien d'autre. */
export const databaseEngineSchema = z.enum(['mysql', 'postgres']);
export type DatabaseEngine = z.infer<typeof databaseEngineSchema>;

/**
 * Par où passe la connexion.
 *
 * `direct` — le serveur joint l'hôte lui-même.
 * `ssh` — un tunnel TCP est ouvert dans le processus, sans binaire externe ni
 * fichier de clé sur disque.
 * `socks` — la connexion transite par un proxy SOCKS5 déjà en place.
 */
export const databaseAccessKindSchema = z.enum(['direct', 'ssh', 'socks']);
export type DatabaseAccessKind = z.infer<typeof databaseAccessKindSchema>;

/** Comment le tunnel s'authentifie, quand il y en a un. */
export const databaseSshAuthSchema = z.enum(['password', 'key']);
export type DatabaseSshAuth = z.infer<typeof databaseSshAuthSchema>;

/**
 * L'état de la dernière connexion connue.
 *
 * `unknown` n'est pas une panne : c'est l'état normal d'une base qu'on n'a
 * jamais jointe, ce qui est le cas par défaut de toutes. Le confondre avec
 * `down` ferait passer une feature au repos pour une feature en alerte.
 */
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
    /** Un mot de passe est enregistré — jamais lequel. */
    /**
     * Cet élément vient d'un **autre espace**, qui le projette ici.
     *
     * L'écran le signale d'une pastille : sans elle, rien ne distingue une
     * ligne locale d'une fenêtre sur l'espace voisin — et les gestes réservés
     * au domicile (supprimer, re-partager) sembleraient cassés au lieu de
     * s'expliquer.
     */
    foreign: z.boolean(),
    hasPassword: z.boolean(),
    access: databaseAccessSchema,
    /** Le relevé périodique tourne-t-il ? Désactivé par défaut. */
    monitorEnabled: z.boolean(),
    /** Cadence du relevé, en secondes. Sans effet si le relevé est éteint. */
    intervalSeconds: z.number().int().positive(),
    /**
     * Charger l'inventaire des tables dès l'ouverture de la fiche.
     *
     * Éteint par défaut, comme tout ce qui joint un serveur dans cette feature.
     * Allumé, c'est le **seul** endroit où une connexion part sans qu'on ait
     * cliqué — d'où le réglage par base plutôt qu'un comportement global.
     */
    autoLoadTables: z.boolean(),
    lastCheckAt: z.number().int().nullable(),
    /**
     * Ce qu'a duré le dernier relevé, en millisecondes.
     *
     * Mesuré de l'ouverture de la connexion à la fin de l'inventaire : c'est le
     * temps de réponse **du serveur tel qu'on l'atteint**, tunnel compris, et
     * non celui d'une requête isolée. Renseigné même sur un échec — un relevé
     * qui met douze secondes à échouer dit quelque chose qu'un simple
     * « injoignable » ne dit pas.
     */
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
    /** Combien de projets s'en servent — l'interconnexion, comme pour un dépôt. */
    projectCount: z.number().int().nonnegative(),
    created: z.number().int()
});
export type Database = z.infer<typeof databaseSchema>;

/**
 * Un projet qui utilise cette base.
 *
 * Ne remonte que des projets à l'étage ouvert — un projet confidentiel ne peut
 * pas être lié, donc le titre est toujours lisible sans session.
 */
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
    /**
     * Nombre de lignes **estimé**, tel que le moteur le tient dans ses
     * statistiques : un `COUNT(*)` exact sur chaque table d'un serveur de
     * production coûterait bien plus que ce que cette colonne apporte. `null`
     * quand le moteur n'a pas encore analysé la table.
     */
    rowCount: z.number().int().nonnegative().nullable(),
    sizeBytes: z.number().int().nonnegative().nullable()
});
export type DatabaseTable = z.infer<typeof databaseTableSchema>;

/**
 * Le contenu d'une table, ou le résultat d'une requête.
 *
 * Les valeurs voyagent en **chaînes**, jamais dans leur type d'origine : un
 * `BIGINT` dépasse le nombre sûr de JavaScript, une date n'a pas la même forme
 * chez les deux moteurs, et un `BLOB` n'a aucune représentation JSON. Le
 * formatage appartient à l'affichage ; le transport, lui, doit être fidèle.
 */
export const databaseRowsSchema = z.object({
    columns: z.array(z.string()),
    rows: z.array(z.array(z.string().nullable())),
    /** Total de lignes de la table, si le moteur a pu le donner. */
    total: z.number().int().nonnegative().nullable(),
    elapsedMs: z.number().int().nonnegative()
});
export type DatabaseRows = z.infer<typeof databaseRowsSchema>;

// ------------------------------------------------------------- structure

/** Une colonne, telle que le catalogue du moteur la décrit. */
export const databaseColumnSchema = z.object({
    name: z.string(),
    /** Le type tel que le moteur le nomme : `varchar(255)`, `int unsigned`… */
    type: z.string(),
    nullable: z.boolean(),
    /** L'expression par défaut, telle quelle ; `null` quand il n'y en a pas. */
    default: z.string().nullable(),
    primaryKey: z.boolean(),
    /**
     * Le moteur la remplit seul : auto-incrément, identité, colonne générée.
     * Le formulaire d'ajout ne la propose donc pas — la renseigner à la main
     * serait au mieux ignoré, au pire refusé.
     */
    generated: z.boolean(),
    comment: z.string()
});
export type DatabaseColumn = z.infer<typeof databaseColumnSchema>;

/**
 * Une clé étrangère, et ce qu'elle vise.
 *
 * `columns` et `refColumns` sont **appariées par position** : la première de
 * l'une pointe la première de l'autre. C'est ce qui permet de suivre une
 * contrainte composite sans deviner.
 */
export const databaseForeignKeySchema = z.object({
    name: z.string(),
    columns: z.array(z.string()).min(1),
    refSchema: z.string(),
    refTable: z.string(),
    refColumns: z.array(z.string()).min(1)
});
export type DatabaseForeignKey = z.infer<typeof databaseForeignKeySchema>;

/** Un index, clé primaire exclue — celle-ci est portée par les colonnes. */
export const databaseIndexSchema = z.object({
    name: z.string(),
    columns: z.array(z.string()),
    unique: z.boolean()
});
export type DatabaseIndex = z.infer<typeof databaseIndexSchema>;

/**
 * La structure d'une table : ce qu'il faut pour la lire, l'écrire et la suivre.
 *
 * Un seul objet parce que ses trois usages sont indissociables : le panneau
 * « Structure » l'affiche, le formulaire de ligne en tire ses champs, et la
 * navigation par clé étrangère en tire ses liens. Les charger séparément
 * multiplierait les allers-retours pour une même sélection de table.
 */
export const databaseStructureSchema = z.object({
    schema: z.string(),
    table: z.string(),
    columns: z.array(databaseColumnSchema),
    /**
     * Les colonnes qui désignent une ligne, dans l'ordre de la clé.
     *
     * **Vide = pas de clé primaire**, et c'est décisif : sans elle, aucune
     * modification ni suppression n'est proposée. Une table sans clé ne permet
     * pas de nommer *une* ligne, et un `DELETE` qui en emporterait deux est un
     * accident qu'on ne peut pas rattraper.
     */
    primaryKey: z.array(z.string()),
    foreignKeys: z.array(databaseForeignKeySchema),
    indexes: z.array(databaseIndexSchema)
});
export type DatabaseStructure = z.infer<typeof databaseStructureSchema>;

// --------------------------------------------------------------- recherche

/**
 * Comment une colonne est confrontée à une valeur.
 *
 * Fermé, et c'est le point : la recherche ne transporte jamais de fragment de
 * SQL. Le serveur choisit l'opérateur dans cette liste et lie la valeur en
 * paramètre — une valeur ne peut donc pas devenir du code.
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

// ------------------------------------------------------- écriture de lignes

/**
 * La valeur d'une colonne, à l'écriture.
 *
 * `null` est un vrai `NULL`, et non la chaîne vide : les deux se distinguent à
 * la saisie, et les confondre viderait une colonne « non nulle » au lieu de
 * refuser. Tout le reste voyage en chaîne, comme à la lecture — le moteur
 * convertit, le paramètre étant lié.
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

/** Les formats d'export proposés. */
export const databaseExportFormatSchema = z.enum(['csv', 'json', 'sql']);
export type DatabaseExportFormat = z.infer<typeof databaseExportFormatSchema>;

/**
 * Une plage d'identifiants à exporter, bornes comprises.
 *
 * Deux nombres et non un fragment de texte : « 1-500, 900 » est une commodité de
 * saisie, elle est analysée dans le navigateur et ne traverse jamais le contrat.
 * Le serveur ne reçoit donc que des bornes, qu'il lie en paramètres — un
 * identifiant saisi ne peut pas devenir du SQL. Une valeur seule s'écrit
 * `{ from: n, to: n }`.
 */
export const databaseIdRangeSchema = z.object({
    from: z.number().int(),
    to: z.number().int()
});
export type DatabaseIdRange = z.infer<typeof databaseIdRangeSchema>;

/** Comment une mesure est comparée à son seuil. */
export const databaseComparatorSchema = z.enum(['gt', 'gte', 'lt', 'lte', 'eq', 'ne']);
export type DatabaseComparator = z.infer<typeof databaseComparatorSchema>;

/**
 * Une condition d'alerte : une requête qui rend **un seul nombre**, comparée à
 * un seuil.
 *
 * Un seul nombre, et c'est la contrainte qui rend le reste possible : un
 * `SELECT COUNT(*) …` ou un `SELECT AVG(…) …` se compare, se raconte dans un
 * message et se relit dans l'historique. Une requête qui rendrait un tableau
 * n'aurait pas de vérité à confronter à un seuil.
 */
export const databaseConditionSchema = z.object({
    sql: z.string().min(1).max(DATABASE_SQL_MAX_LENGTH),
    comparator: databaseComparatorSchema,
    threshold: z.number(),
    /** Nom court de la mesure, repris dans le message ({@link databaseAlertSchema}). */
    label: z.string().max(DATABASE_ALERT_NAME_MAX_LENGTH)
});
export type DatabaseCondition = z.infer<typeof databaseConditionSchema>;

/** Comment les conditions se combinent. */
export const databaseCombinatorSchema = z.enum(['and', 'or']);
export type DatabaseCombinator = z.infer<typeof databaseCombinatorSchema>;

/**
 * Une alerte : des conditions, un opérateur qui les relie, un message.
 *
 * Évaluée par le relevé périodique, donc **seulement si celui-ci est actif** sur
 * la base. Une alerte définie sur une base au repos est inerte, et l'interface
 * le dit plutôt que de laisser croire à une surveillance qui n'existe pas.
 *
 * La notification part sur les canaux de l'espace — le compte mail et le webhook
 * réglés dans Uptime — parce que ce sont les mêmes canaux pour les mêmes
 * personnes, et qu'en avoir deux jeux à tenir à jour serait une source d'erreur
 * de plus.
 */
export const databaseAlertSchema = z.object({
    id: z.number().int().positive(),
    databaseId: z.number().int().positive(),
    name: z.string().max(DATABASE_ALERT_NAME_MAX_LENGTH),
    enabled: z.boolean(),
    combinator: databaseCombinatorSchema,
    conditions: z.array(databaseConditionSchema),
    /**
     * Le message envoyé. `{label}` y est remplacé par la valeur mesurée de la
     * condition portant ce nom — c'est ce qui permet d'écrire « déjà {erreurs}
     * erreurs cette heure-ci » plutôt qu'un texte qui ne dit rien de la mesure.
     */
    message: z.string().max(DATABASE_ALERT_MESSAGE_MAX_LENGTH),
    /** L'alerte est-elle franchie **en ce moment** ? */
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

// --------------------------------------------------------------- lignes SQL

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
    /** Durée du dernier relevé, en ms. Renseignée aussi sur un échec. */
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
