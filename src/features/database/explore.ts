import {
    databaseExecute,
    databaseExport,
    databaseRowDelete,
    databaseRowInsert,
    databaseRowUpdate,
    databaseTableList,
    databaseTableRows,
    databaseTableStructure
} from 'deveye-types';
import type { DatabaseCell, DatabaseRows, DatabaseStructure, DatabaseTable } from 'deveye-types';
import { ROWS_PAGE_DEFAULT, type Session } from '@/Services/databases/engine';
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

/** Le plafond d'un export : il traverse la connexion en un seul morceau. */
const EXPORT_MAX_ROWS = 20_000;
const EXPORT_MAX_BYTES = 6_000_000;
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

export const databaseExportFeature: FeatureDefinition<
    typeof databaseExport.command,
    typeof databaseExport.input,
    typeof databaseExport.output
> = defineFeature({
    ...databaseExport,
    access: WRITE,
    handler: async (ctx, input) => {
        return withSession(ctx, input.databaseId, async (s) => {
            const all = await s.tables();
            const targets = input.table === undefined ? all : [await resolveTable(s, input.schema ?? '', input.table)];

            const parts: string[] = [];
            let bytes = 0;
            let rowCount = 0;
            let truncated = false;

            for (const table of targets) {
                if (truncated) break;
                if (input.format === 'csv' && targets.length > 1) {
                    // Un CSV ne porte qu'une table. Sur un export complet, on
                    // les sépare par un en-tête nommé plutôt que de mélanger
                    // des colonnes qui n'ont rien à voir.
                    parts.push(`\n# ${table.schema}.${table.name}\n`);
                }
                if (input.format === 'sql') {
                    parts.push(`\n-- ${table.schema}.${table.name}\n`);
                }

                let offset = 0;
                let header = false;
                const jsonRows: string[] = [];
                for (;;) {
                    const page = await s.tableRows(table.schema, table.name, { offset, limit: EXPORT_PAGE });
                    if (page.rows.length === 0) break;

                    for (const row of page.rows) {
                        if (rowCount >= EXPORT_MAX_ROWS || bytes >= EXPORT_MAX_BYTES) {
                            truncated = true;
                            break;
                        }
                        let line: string;
                        if (input.format === 'csv') {
                            if (!header) {
                                const head = `${page.columns.map((c) => csvCell(c)).join(',')}\n`;
                                parts.push(head);
                                bytes += head.length;
                                header = true;
                            }
                            line = `${row.map(csvCell).join(',')}\n`;
                        } else if (input.format === 'sql') {
                            const columns = page.columns.map((c) => `\`${c.replace(/`/g, '``')}\``).join(', ');
                            line = `INSERT INTO \`${table.name.replace(/`/g, '``')}\` (${columns}) VALUES (${row
                                .map(sqlLiteral)
                                .join(', ')});\n`;
                        } else {
                            line = `${JSON.stringify(Object.fromEntries(page.columns.map((c, i) => [c, row[i]])))}`;
                            jsonRows.push(line);
                        }
                        if (input.format !== 'json') parts.push(line);
                        bytes += line.length;
                        rowCount++;
                    }

                    if (truncated) break;
                    offset += EXPORT_PAGE;
                    if (page.total !== null && offset >= page.total) break;
                }

                if (input.format === 'json') {
                    parts.push(`{"table":${JSON.stringify(`${table.schema}.${table.name}`)},"rows":[\n`);
                    parts.push(jsonRows.join(',\n'));
                    parts.push('\n]}\n');
                }
            }

            const scope = input.table === undefined ? 'base' : input.table;
            const stamp = new Date().toISOString().slice(0, 10);
            return {
                filename: `${scope}-${stamp}.${input.format}`,
                content: parts.join(''),
                rowCount,
                tableCount: targets.length,
                truncated
            };
        });
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
