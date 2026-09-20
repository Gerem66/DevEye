import { z } from 'zod';

/**
 * La vue d'ensemble d'un projet : l'agencement de ses tuiles, et les indicateurs
 * sur mesure qu'il mesure lui-même contre une base reliée.
 *
 * L'agencement appartient au PROJET et non à son lecteur : deux membres qui
 * ouvrent le même projet voient la même vue, comme ils voient le même tableau.
 * Il vit hors du corps chiffré, pour que réordonner et masquer ne déchiffrent
 * rien : un projet confidentiel verrouillé doit pouvoir arranger ses tuiles de
 * tâches, qui sont les seules à ne dépendre d'aucun service extérieur.
 */

export const DASHBOARD_TILE_KEY_MAX_LENGTH = 64;
export const DASHBOARD_KPI_TITLE_MAX_LENGTH = 48;
export const DASHBOARD_KPI_UNIT_MAX_LENGTH = 16;
export const DASHBOARD_KPI_SQL_MAX_LENGTH = 4000;
export const DASHBOARD_MAX_KPIS = 12;

/** Au-delà, la tuile dit « à rafraîchir » et propose de remesurer. */
export const KPI_STALE_SECONDS = 900;

/** Échéance dans les sept jours : « cette semaine », sans ambiguïté. */
export const DUE_SOON_DAYS = 7;

export const dashboardComparatorSchema = z.enum(['gt', 'gte', 'lt', 'lte', 'eq', 'ne']);
export type DashboardComparator = z.infer<typeof dashboardComparatorSchema>;

/** Ce qui définit un indicateur sur mesure. Chiffré : la requête dit le métier du projet. */
export const dashboardKpiDraftSchema = z.object({
    title: z.string().min(1).max(DASHBOARD_KPI_TITLE_MAX_LENGTH),
    /** Une seule instruction de lecture, qui rend une seule ligne et une seule colonne. */
    sql: z.string().min(1).max(DASHBOARD_KPI_SQL_MAX_LENGTH),
    /** Suffixe libre affiché après le nombre (« € », « commandes »). */
    unit: z.string().max(DASHBOARD_KPI_UNIT_MAX_LENGTH),
    /** Franchi, le nombre se teinte. `null` = pas de seuil, la tuile reste neutre. */
    comparator: dashboardComparatorSchema.nullable(),
    threshold: z.number().nullable()
});
export type DashboardKpiDraft = z.infer<typeof dashboardKpiDraftSchema>;

export const dashboardKpiSchema = dashboardKpiDraftSchema.extend({
    /** La base mesurée, qui doit être reliée au projet. */
    databaseId: z.number().int().positive(),
    /** Le dernier nombre connu. Gardé même après un échec, grisé sous le message. */
    lastValue: z.number().nullable(),
    lastError: z.string().nullable(),
    lastCheckAt: z.number().int().nullable()
});
export type DashboardKpi = z.infer<typeof dashboardKpiSchema>;

/**
 * Une tuile arrangée. `key` est stable et porte tout : une tuile automatique la
 * tient du catalogue du client (« tasks.counts », « deploy.last:12 »), un
 * indicateur la reçoit à sa création (« kpi:<16 hexa> »). L'ordre ne parle que
 * de clés, jamais d'identifiants de rangée.
 */
export const dashboardTileSchema = z.object({
    key: z.string().min(1).max(DASHBOARD_TILE_KEY_MAX_LENGTH),
    sortOrder: z.number().int().nonnegative(),
    /** Masquée : la tuile garde son rang et ne se dessine pas. */
    hidden: z.boolean(),
    /** `null` sur une tuile automatique, qui ne porte aucune définition. */
    kpi: dashboardKpiSchema.nullable()
});
export type DashboardTile = z.infer<typeof dashboardTileSchema>;

/** Ce qu'une bascule d'ordre ou de visibilité envoie : la liste complète, dans l'ordre voulu. */
export const dashboardArrangementSchema = z.object({
    key: z.string().min(1).max(DASHBOARD_TILE_KEY_MAX_LENGTH),
    hidden: z.boolean()
});
export type DashboardArrangement = z.infer<typeof dashboardArrangementSchema>;

/** Une mesure, ou la raison qu'il n'y en ait pas. Ne lève jamais. */
export const dashboardMeasureSchema = z.object({
    key: z.string(),
    value: z.number().nullable(),
    error: z.string().nullable(),
    at: z.number().int()
});
export type DashboardMeasure = z.infer<typeof dashboardMeasureSchema>;

/** Ligne SQL (serveur uniquement). */
export interface DashboardTileRow {
    id: number;
    project_id: number;
    workspace_id: number;
    tile_key: string;
    sort_order: number;
    hidden: number;
    database_id: number | null;
    content: string;
    last_number: number | null;
    last_error: string | null;
    last_check_at: number | null;
    created: number;
}
