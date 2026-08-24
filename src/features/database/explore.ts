import {
    databaseExecute,
    databaseExport,
    databaseRowDelete,
    databaseRowInsert,
    databaseRowUpdate,
    databaseTableList,
    databaseTableRows,
    databaseTableStructure
} from '@deveye/types';
import type {
    DatabaseCell,
    DatabaseExportFormat,
    DatabaseIdRange,
    DatabaseRows,
    DatabaseStructure,
    DatabaseTable
} from '@deveye/types';
import { ROWS_PAGE_DEFAULT, type IdRanges, type Session } from '@/Services/databases/engine';
import { defineFeature, FeatureError, type FeatureDefinition } from '../_define';
import { WRITE } from './_shared';
import { withSession } from './probe';

/**
 * L'exploration et l'administration des tables.
 *
 * ## La règle qui tient tout le fichier
 *
 * **Aucun nom venu du client n'entre tel quel dans une requête.** Un identifiant
 * — table, colonne, sens du tri — ne peut pas être un paramètre lié : il faut
 * bien l'écrire dans le texte. La seule parade sûre n'est pas de le nettoyer,
 * mais de le **confronter au catalogue réel** et de n'utiliser que ce que le
 * serveur a lui-même nommé. `resolveTable` et `resolveColumns` ci-dessous sont
 * ce point de passage, et rien n'atteint le moteur sans y passer.
 *
 * Les valeurs, elles, sont toujours liées, et l'opérateur d'un filtre est choisi
 * dans une énumération fermée du contrat. Il n'existe donc aucun chemin par
 * lequel une saisie devienne du code.
 *
 * ## Ce qui décide en dernier ressort
 *
 * Le compte saisi dans les réglages de la base. DevEye peut demander une
 * écriture ; c'est le serveur distant qui l'accorde ou la refuse. Un compte en
 * lecture seule rend donc tout ce fichier inoffensif — ce que le formulaire de
 * la base dit explicitement.
 */

/**
 * Le plafond d'un export — un **garde-fou mémoire**, pas une limite produit.
 *
 * L'export lit tout ce que la portée désigne : c'est ce qu'on lui demande, et
 * s'arrêter à vingt mille lignes en le taisant serait pire que ne pas exporter.
 * Reste qu'il se construit en mémoire avant de traverser la connexion en un seul
 * morceau : au-delà de ces bornes, ce n'est plus l'export qui souffre mais le
 * serveur. Elles sont donc placées là où un export réel n'arrive jamais, et
 * quand elles sont touchées `truncated` le dit sans détour.
 */
const EXPORT_MAX_ROWS = 5_000_000;
const EXPORT_MAX_BYTES = 64_000_000;
/** Lignes lues par tour pendant un export, pour ne pas tout tenir en mémoire. */
const EXPORT_PAGE = 500;

/**
 * La table telle que le **serveur** la nomme, ou `not_found`.
 *
 * On ne rend jamais le nom reçu : on rend celui du catalogue. Un nom qui n'y
 * figure pas n'atteint donc aucune requête, et la casse est celle du serveur.
 */
async function resolveTable(session: Session, schema: string, table: string): Promise<DatabaseTable> {
    const tables = await session.tables();
    const found = tables.find((t) => t.name === table && (schema === '' || t.schema === schema));
    if (!found) throw new FeatureError('not_found', 'Cette table n’existe pas dans cette base.');
    return found;
}

/** Idem pour des colonnes : chacune doit exister dans la structure lue. */
function resolveColumns(structure: DatabaseStructure, names: string[]): void {
    const known = new Set(structure.columns.map((c) => c.name));
    for (const name of names) {
        if (!known.has(name)) {
            throw new FeatureError('validation', `La colonne « ${name} » n’existe pas dans cette table.`);
        }
    }
}

/**
 * La clé primaire, ou un refus qui explique pourquoi.
 *
 * Sans clé primaire, aucune condition ne désigne *une* ligne : un `UPDATE` en
 * toucherait plusieurs et un `DELETE` en emporterait autant, sans retour
 * possible. Mieux vaut ne pas savoir faire que faire trop.
 */
function requirePrimaryKey(structure: DatabaseStructure): string[] {
    if (structure.primaryKey.length === 0) {
        throw new FeatureError(
            'conflict',
            'Cette table n’a pas de clé primaire : DevEye ne peut pas désigner une ligne précise, ' +
                'et refuse de modifier ou supprimer au risque d’en toucher plusieurs.'
        );
    }
    return structure.primaryKey;
}

/** La clé fournie doit couvrir exactement les colonnes de la clé primaire. */
function checkKey(structure: DatabaseStructure, key: DatabaseCell[]): void {
    const primary = requirePrimaryKey(structure);
    resolveColumns(
        structure,
        key.map((c) => c.column)
    );
    const given = new Set(key.map((c) => c.column));
    if (given.size !== primary.length || primary.some((c) => !given.has(c))) {
        throw new FeatureError(
            'validation',
            `La ligne doit être désignée par sa clé primaire complète (${primary.join(', ')}).`
        );
    }
}

export const databaseTableListFeature: FeatureDefinition<
    typeof databaseTableList.command,
    typeof databaseTableList.input,
    typeof databaseTableList.output
> = defineFeature({
    ...databaseTableList,
    access: WRITE,
    handler: async (ctx, input) => ({
        tables: await withSession(ctx, input.databaseId, (s) => s.tables())
    })
});

export const databaseTableStructureFeature: FeatureDefinition<
    typeof databaseTableStructure.command,
    typeof databaseTableStructure.input,
    typeof databaseTableStructure.output
> = defineFeature({
    ...databaseTableStructure,
    access: WRITE,
    handler: async (ctx, input) => ({
        structure: await withSession(ctx, input.databaseId, async (s) => {
            const table = await resolveTable(s, input.schema, input.table);
            return s.structure(table.schema, table.name);
        })
    })
});

export const databaseTableRowsFeature: FeatureDefinition<
    typeof databaseTableRows.command,
    typeof databaseTableRows.input,
    typeof databaseTableRows.output
> = defineFeature({
    ...databaseTableRows,
    access: WRITE,
    handler: async (ctx, input) => {
        return withSession(ctx, input.databaseId, async (s) => {
            const table = await resolveTable(s, input.schema, input.table);

            // La structure est lue dès qu'un filtre, un tri ou l'appelant la
            // réclame : c'est elle qui valide les colonnes citées, et la lire
            // ici évite une seconde session — donc un second tunnel.
            const needsStructure =
                input.withStructure === true || input.sort !== undefined || (input.filters?.length ?? 0) > 0;
            const structure = needsStructure ? await s.structure(table.schema, table.name) : null;
            if (structure) {
                resolveColumns(structure, [
                    ...(input.filters ?? []).map((f) => f.column),
                    ...(input.sort ? [input.sort.column] : [])
                ]);
            }

            const rows: DatabaseRows = await s.tableRows(table.schema, table.name, {
                offset: input.offset ?? 0,
                limit: input.limit ?? ROWS_PAGE_DEFAULT,
                filters: input.filters,
                combinator: input.combinator,
                sort: input.sort
            });
            return { rows, ...(input.withStructure === true && structure ? { structure } : {}) };
        });
    }
});

export const databaseRowInsertFeature: FeatureDefinition<
    typeof databaseRowInsert.command,
    typeof databaseRowInsert.input,
    typeof databaseRowInsert.output
> = defineFeature({
    ...databaseRowInsert,
    access: WRITE,
    handler: async (ctx, input) => ({
        inserted: await withSession(ctx, input.databaseId, async (s) => {
            const table = await resolveTable(s, input.schema, input.table);
            const structure = await s.structure(table.schema, table.name);
            resolveColumns(
                structure,
                input.values.map((v) => v.column)
            );
            return s.insertRow(table.schema, table.name, input.values);
        })
    })
});

export const databaseRowUpdateFeature: FeatureDefinition<
    typeof databaseRowUpdate.command,
    typeof databaseRowUpdate.input,
    typeof databaseRowUpdate.output
> = defineFeature({
    ...databaseRowUpdate,
    access: WRITE,
    handler: async (ctx, input) => ({
        updated: await withSession(ctx, input.databaseId, async (s) => {
            const table = await resolveTable(s, input.schema, input.table);
            const structure = await s.structure(table.schema, table.name);
            checkKey(structure, input.key);
            resolveColumns(
                structure,
                input.values.map((v) => v.column)
            );
            return s.updateRow(table.schema, table.name, input.key, input.values);
        })
    })
});

export const databaseRowDeleteFeature: FeatureDefinition<
    typeof databaseRowDelete.command,
    typeof databaseRowDelete.input,
    typeof databaseRowDelete.output
> = defineFeature({
    ...databaseRowDelete,
    access: WRITE,
    handler: async (ctx, input) => ({
        deleted: await withSession(ctx, input.databaseId, async (s) => {
            const table = await resolveTable(s, input.schema, input.table);
            const structure = await s.structure(table.schema, table.name);
            for (const key of input.keys) checkKey(structure, key);
            return s.deleteRows(table.schema, table.name, input.keys);
        })
    })
});

export const databaseExecuteFeature: FeatureDefinition<
    typeof databaseExecute.command,
    typeof databaseExecute.input,
    typeof databaseExecute.output
> = defineFeature({
    ...databaseExecute,
    access: WRITE,
    handler: async (ctx, input) => ({
        result: await withSession(ctx, input.databaseId, (s) => s.execute(input.sql))
    })
});

/** Une valeur dans une cellule CSV : guillemets doublés, champ toujours cité. */
function csvCell(value: string | null): string {
    if (value === null) return '';
    return `"${value.replace(/"/g, '""')}"`;
}

/** Une valeur dans un `INSERT` : littéral cité, apostrophes doublées. */
function sqlLiteral(value: string | null): string {
    if (value === null) return 'NULL';
    return `'${value.replace(/'/g, "''")}'`;
}

/** Ce qu'un export vise, sans l'identifiant de base ni le contexte. */
export interface ExportRequest {
    format: DatabaseExportFormat;
    schema?: string;
    table?: string;
    /**
     * Plages d'identifiants, bornes comprises.
     *
     * N'a de sens que sur **une** table : d'une table à l'autre, la clé primaire
     * n'a ni le même nom ni le même sens, et « 1 à 500 » ne désignerait pas les
     * mêmes objets. Sur une portée « toute la base », elles sont ignorées — ce
     * que l'interface dit avant de laisser saisir quoi que ce soit.
     */
    idRanges?: DatabaseIdRange[];
}

/**
 * Le plafond, et pourquoi il est un paramètre.
 *
 * Il pourrait être une constante lue directement ; le passer permet de vérifier
 * la troncature sans écrire vingt mille lignes dans une base d'essai. Le défaut
 * reste la seule valeur qu'utilise la commande.
 */
export interface ExportLimits {
    maxRows: number;
    maxBytes: number;
    page: number;
}

export const DEFAULT_EXPORT_LIMITS: ExportLimits = {
    maxRows: EXPORT_MAX_ROWS,
    maxBytes: EXPORT_MAX_BYTES,
    page: EXPORT_PAGE
};

/**
 * Construit un export, table par table et page par page.
 *
 * Séparé du handler pour une raison simple : c'est la seule logique du fichier
 * qui mérite d'être vérifiée sur pièces — trois formats, une pagination, un
 * plafond — et la mêler à l'ouverture de session la rendrait inatteignable.
 *
 * Le plafond se compte en **octets réels** (`Buffer.byteLength`) et non en
 * caractères : un contenu accentué ou asiatique dépasserait sinon d'un tiers ce
 * que l'écran a annoncé.
 */
export async function buildExport(
    session: Session,
    request: ExportRequest,
    limits: ExportLimits = DEFAULT_EXPORT_LIMITS
): Promise<{ content: string; rowCount: number; tableCount: number; truncated: boolean }> {
    const all = await session.tables();
    const targets =
        request.table === undefined ? all : [await resolveTable(session, request.schema ?? '', request.table)];

    // Les plages ne s'appliquent qu'à une table unique, et seulement si sa clé
    // primaire tient en une colonne : sur une clé composite, « 1 à 500 » ne
    // désigne rien de précis. Le nom de colonne vient du catalogue, jamais du
    // client — c'est ce qui autorise à le citer.
    let ranges: IdRanges | undefined;
    if (request.idRanges !== undefined && request.idRanges.length > 0 && targets.length === 1) {
        const only = targets[0];
        const structure = await session.structure(only.schema, only.name);
        if (structure.primaryKey.length !== 1) {
            throw new FeatureError(
                'conflict',
                'Filtrer par identifiants demande une clé primaire d’une seule colonne ; ' +
                    `« ${only.name} » n’en a pas.`
            );
        }
        ranges = { column: structure.primaryKey[0], ranges: request.idRanges };
    }

    const parts: string[] = [];
    let bytes = 0;
    let rowCount = 0;
    let truncated = false;
    const push = (text: string) => {
        parts.push(text);
        bytes += Buffer.byteLength(text);
    };

    // Un document JSON valide, et non une suite d'objets collés : le résultat
    // doit pouvoir être relu par n'importe quel outil sans découpage préalable.
    if (request.format === 'json') parts.push('[\n');

    for (const [index, table] of targets.entries()) {
        if (truncated) break;
        if (request.format === 'csv' && targets.length > 1) {
            // Un CSV ne porte qu'une table. Sur un export complet, on les sépare
            // par un en-tête nommé plutôt que de mélanger des colonnes qui n'ont
            // rien à voir.
            push(`\n# ${table.schema}.${table.name}\n`);
        }
        if (request.format === 'sql') push(`\n-- ${table.schema}.${table.name}\n`);
        if (request.format === 'json') push(`${index > 0 ? ',\n' : ''}{"table":${JSON.stringify(table.name)},"rows":[`);

        let offset = 0;
        let header = false;
        let first = true;
        for (;;) {
            const page = await session.tableRows(table.schema, table.name, {
                offset,
                limit: limits.page,
                ...(ranges ? { ranges } : {})
            });
            if (page.rows.length === 0) break;

            for (const row of page.rows) {
                if (rowCount >= limits.maxRows || bytes >= limits.maxBytes) {
                    truncated = true;
                    break;
                }
                if (request.format === 'csv') {
                    if (!header) {
                        push(`${page.columns.map(csvCell).join(',')}\n`);
                        header = true;
                    }
                    push(`${row.map(csvCell).join(',')}\n`);
                } else if (request.format === 'sql') {
                    const columns = page.columns.map((c) => `\`${c.replace(/`/g, '``')}\``).join(', ');
                    push(
                        `INSERT INTO \`${table.name.replace(/`/g, '``')}\` (${columns}) ` +
                            `VALUES (${row.map(sqlLiteral).join(', ')});\n`
                    );
                } else {
                    push(
                        `${first ? '\n' : ',\n'}${JSON.stringify(
                            Object.fromEntries(page.columns.map((c, i) => [c, row[i]]))
                        )}`
                    );
                }
                first = false;
                rowCount++;
            }

            if (truncated) break;
            offset += limits.page;
            if (page.total !== null && offset >= page.total) break;
        }

        if (request.format === 'json') push('\n]}');
    }

    if (request.format === 'json') parts.push('\n]\n');

    return { content: parts.join(''), rowCount, tableCount: targets.length, truncated };
}

export const databaseExportFeature: FeatureDefinition<
    typeof databaseExport.command,
    typeof databaseExport.input,
    typeof databaseExport.output
> = defineFeature({
    ...databaseExport,
    access: WRITE,
    handler: async (ctx, input) => {
        const built = await withSession(ctx, input.databaseId, (s) => buildExport(s, input));
        const scope = input.table === undefined ? 'base' : input.table;
        const stamp = new Date().toISOString().slice(0, 10);
        return { filename: `${scope}-${stamp}.${input.format}`, ...built };
    }
});

export const databaseExploreFeatures = [
    databaseTableListFeature,
    databaseTableStructureFeature,
    databaseTableRowsFeature,
    databaseRowInsertFeature,
    databaseRowUpdateFeature,
    databaseRowDeleteFeature,
    databaseExecuteFeature,
    databaseExportFeature
];
