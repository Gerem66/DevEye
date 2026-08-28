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
 * Commandes des bases de données de l'espace.
 *
 * Préfixe unique `database.`, comme `git.` et `projects.` — d'où le camelCase
 * derrière le point.
 *
 * ⚠️ Conséquence à connaître : le filet de démarrage (`MUTATION_VERB` dans
 * `src/features/_topics.ts`) cherche un verbe **juste après le point**. Il ne
 * verra donc **aucune** de ces commandes, et un `mutates` oublié ne produira
 * aucun avertissement. Il se relit à la main.
 *
 * ## Rien ne se connecte tout seul
 *
 * Seules `test`, `inspect`, `tableList`, `tableRows` et `alertTest` joignent la
 * base, et toutes sont déclenchées par un geste explicite. `list` et `get`
 * lisent le cache local — ouvrir la feature ne réveille aucun serveur.
 *
 * L'espace visé n'apparaît dans aucune entrée : il voyage sur l'enveloppe WS et
 * le dispatcheur le résout, appartenance vérifiée, avant le handler.
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
    /**
     * Mot de passe SSH ou clé privée. Absent = on garde celui en place ; une
     * chaîne vide l'efface. Le client ne le reçoit jamais, il ne peut donc pas
     * le renvoyer inchangé — d'où cette convention plutôt qu'un champ obligatoire.
     */
    secret: z.string().max(DATABASE_SECRET_MAX_LENGTH).optional()
});

// ------------------------------------------------------------------- bases

/** Le nombre de bases de l'espace, pour la tuile de l'accueil. */
export const databaseCount = {
    command: 'database.count' as const,
    input: z.object({}),
    output: z.object({ count: z.number().int().nonnegative() })
};

/** Les bases de l'espace, dans l'ordre de l'utilisateur. Lit le cache local. */
export const databaseList = {
    command: 'database.list' as const,
    input: z.object({}),
    output: z.object({ databases: z.array(databaseSchema) })
};

/** Une base, avec les projets qui s'en servent et ses alertes. */
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

/**
 * Modifie une base. `password` absent = on garde celui en place ; une chaîne
 * vide l'efface. Même convention que le secret du tunnel, et pour la même
 * raison : un secret rendu au client est un secret qu'on ne peut plus reprendre.
 */
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

/**
 * Retire une base de l'espace, avec ses alertes et toutes ses liaisons.
 *
 * Les projets liés ne sont **pas** touchés : ils perdent leur base, rien
 * d'autre. Le serveur distant, lui, n'est évidemment jamais atteint.
 */
export const databaseRemove = {
    command: 'database.remove' as const,
    input: z.object({ databaseId }),
    output: z.object({ databaseId })
};

/**
 * Range les bases de l'espace : `ids` est la liste **complète** dans son ordre
 * final. Une nouvelle base prend le rang suivant, donc la fin de la liste.
 */
export const databaseReorder = {
    command: 'database.reorder' as const,
    input: z.object({ ids: z.array(databaseId).min(1) }),
    output: z.object({ ids: z.array(databaseId) })
};

// ------------------------------------------------------- à la demande

/**
 * Essaie de joindre la base, maintenant.
 *
 * Ne lève **jamais** sur un échec de connexion : un serveur injoignable est une
 * réponse, pas une erreur de commande. Le message revient dans `error`, déjà
 * traduit, et l'interface le montre sans rien bloquer.
 */
export const databaseTest = {
    command: 'database.test' as const,
    input: z.object({ databaseId }),
    output: z.object({ probe: databaseProbeSchema })
};

/**
 * Essaie une connexion **avant** de l'enregistrer.
 *
 * Le formulaire d'ajout décrit une base qui n'existe pas encore : `test` ne peut
 * rien pour lui, il part d'un identifiant. Celui-ci prend les réglages tels
 * qu'ils sont saisis, et n'écrit rien — ni ligne, ni état.
 *
 * `databaseId` sert à la modification : les secrets ne redescendant jamais au
 * client, un champ laissé intact n'a rien à renvoyer, et le serveur reprend
 * alors celui qu'il détient déjà. Sans cela, « Tester » échouerait sur une base
 * qui fonctionne, faute de mot de passe.
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

/**
 * Relève l'inventaire maintenant : version du serveur, taille, nombre de
 * tables, et l'état des alertes. C'est ce que fait le relevé périodique, sur
 * demande explicite — ce qui le rend utile même sur une base au repos.
 */
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
 * Le contenu d'une table, page par page.
 *
 * ## Rien de ce qui vient du client n'entre tel quel dans une requête
 *
 * Un identifiant ne peut pas être un paramètre lié : nom de table, nom de
 * colonne, sens du tri sont donc **confrontés au catalogue réel** avant d'être
 * cités, et un nom qui n'y figure pas n'atteint jamais le moteur. Les valeurs,
 * elles, sont toujours liées ; l'opérateur d'un filtre est choisi dans une
 * énumération fermée. Aucun fragment de SQL ne traverse le contrat.
 *
 * `withStructure` évite un second aller-retour à la sélection d'une table : la
 * structure et la première page arrivent alors dans la **même session**, ce qui
 * compte quand chaque connexion rouvre un tunnel SSH.
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

// ------------------------------------------------------- écrire des lignes

/**
 * Les trois écritures de l'explorateur.
 *
 * ## Ce que le serveur refuse, et pourquoi
 *
 * Modifier ou supprimer exige une **clé primaire**. Sans elle, aucune condition
 * ne désigne *une* ligne : un `UPDATE` en toucherait plusieurs, un `DELETE` en
 * emporterait autant, et rien ne permettrait de revenir en arrière. Le serveur
 * refuse alors, avec la raison ; l'interface ne propose même pas le geste.
 *
 * ## Ce qui décide en dernier ressort
 *
 * Le compte saisi dans les réglages de la base. DevEye peut demander une
 * écriture ; c'est le serveur distant qui l'accorde ou la refuse. Un compte en
 * lecture seule rend donc tout ceci inoffensif, ce que dit le formulaire.
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
 * Une instruction libre, écriture comprise — le terminal.
 *
 * Distincte de `query`, qui refuse tout ce qui n'est pas une lecture parce
 * qu'elle sert à mettre au point une condition d'alerte. Ici l'intention est
 * l'inverse : administrer. Une seule instruction à la fois malgré tout, le
 * point-virgule interne restant refusé — c'est ce qui empêche qu'un copier-coller
 * en exécute trois quand on en visait une.
 */
export const databaseExecute = {
    command: 'database.execute' as const,
    input: z.object({ databaseId, sql: z.string().min(1).max(DATABASE_SQL_MAX_LENGTH) }),
    output: z.object({ result: databaseExecutionSchema })
};

/**
 * Exporte une table, ou toute la base.
 *
 * L'export est **complet** : il lit tout ce que la portée désigne, page par
 * page. Le seul plafond qui subsiste est un garde-fou mémoire du serveur, très
 * au-dessus de ce qu'un export normal atteint ; s'il est touché, `truncated` le
 * dit et l'interface le répète. Pour une copie fidèle d'un serveur entier,
 * `mysqldump` et `pg_dump` restent malgré tout les bons outils — eux savent
 * rejouer schéma, index et contraintes.
 *
 * `idRanges` restreint l'export aux lignes dont la **clé primaire** tombe dans
 * l'une des plages. Réservé à une portée d'une seule table : sur toute la base,
 * les clés n'ont ni le même nom ni le même sens d'une table à l'autre.
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

// ----------------------------------------------------------------- alertes

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

/**
 * Évalue une alerte tout de suite et rend ce que chaque condition a mesuré,
 * **sans notifier personne**.
 *
 * C'est ce qui rend une condition écrivable : on voit le nombre que rend sa
 * requête avant de choisir un seuil, au lieu d'attendre une notification pour
 * découvrir qu'on s'est trompé de colonne.
 */
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
        /** L'erreur de chaque condition, à sa place — `null` si elle a abouti. */
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
