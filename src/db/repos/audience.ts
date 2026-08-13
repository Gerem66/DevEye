import type { AudienceDimension, AudienceSiteRow, ProjectAudienceLinkRow } from 'deveye-types';
import type { Queryable } from '../pool';

type Q = Queryable;

/** Un site, plus ce que ses tables voisines en disent. */
export interface AudienceSiteWithStatsRow extends AudienceSiteRow {
    project_count: number;
    views_24h: number;
    visitors_24h: number;
}

/** Un projet lié à un site, tel que la jointure le rend. */
export interface AudienceUsageRow {
    project_id: number;
    status: string;
    content: string;
}

/** Une ligne de classement : le libellé **encore chiffré**, et ses deux nombres. */
export interface AudienceBreakdownRow {
    content: string;
    views: number;
    visitors: number;
}

export interface AudienceMetricsRow {
    views: number;
    visitors: number;
    sessions: number;
    duration: number;
    bounces: number;
}

export interface AudiencePointRow {
    at: number;
    views: number;
    visitors: number;
}

export interface AudienceActivityRow {
    day: number;
    hour: number;
    views: number;
}

/**
 * Où vit chaque dimension, et sous quelle colonne.
 *
 * ⚠️ **C'est la seule table qui nomme une colonne dans une requête**, et c'est
 * délibérément une constante fermée : un nom de colonne ne peut pas être un
 * paramètre lié, il faut bien l'écrire dans le texte SQL. La discipline est
 * celle de `features/database/explore.ts` — on n'utilise jamais l'identifiant
 * reçu, on s'en sert pour choisir celui que le serveur détient déjà. Le contrat
 * zod borne déjà l'entrée aux neuf valeurs ; ceci la borne une seconde fois, là
 * où la chaîne devient du code.
 *
 * Deux familles, parce qu'elles ne se comptent pas au même endroit :
 *
 * - `session` — le navigateur, le fuseau, le référent ne changent pas en cours
 *   de visite. Les porter sur la session divise le volume et rend « visiteurs
 *   uniques par navigateur » lisible d'une seule table.
 * - `event` — le chemin et le nom d'un événement changent à chaque coup ; ils
 *   vivent donc sur le fait, et se comptent en le joignant à sa session pour
 *   savoir *qui* l'a produit.
 */
const DIMENSION_SOURCE: Record<AudienceDimension, { table: 'session' | 'event'; column: string; kind?: number }> = {
    path: { table: 'event', column: 'path_id', kind: 0 },
    event: { table: 'event', column: 'name_id', kind: 1 },
    referrer: { table: 'session', column: 'referrer_id' },
    browser: { table: 'session', column: 'browser_id' },
    os: { table: 'session', column: 'os_id' },
    device: { table: 'session', column: 'device_id' },
    timezone: { table: 'session', column: 'timezone_id' },
    language: { table: 'session', column: 'language_id' },
    identity: { table: 'session', column: 'identity_id' }
};

/**
 * Les sites suivis de l'espace, et tout ce qu'on lit d'eux.
 *
 * Ce dépôt-ci est le **chemin froid** : il sert les écrans, quelques fois par
 * minute au plus. L'ingestion, qui écrit des milliers de fois pour un seul de
 * ces appels, a le sien (`audienceIngest.ts`) — les mêmes tables, mais aucune
 * des mêmes contraintes.
 *
 * Tout est à l'étage **ouvert** : un site appartient à l'espace, sert des
 * projets de paliers différents, et ne peut donc suivre aucun d'eux.
 */
export interface AudienceRepo {
    list(workspaceId: number): Promise<AudienceSiteWithStatsRow[]>;
    find(id: number, workspaceId: number): Promise<AudienceSiteRow | null>;
    findWithStats(id: number, workspaceId: number): Promise<AudienceSiteWithStatsRow | null>;
    /** L'unicité d'un site dans l'espace, ce que `content` chiffré ne peut porter. */
    findByName(workspaceId: number, nameRef: string): Promise<AudienceSiteRow | null>;
    count(workspaceId: number): Promise<number>;
    create(input: {
        workspaceId: number;
        publicKey: string;
        nameRef: string;
        platform: string;
        visitorMode: string;
        origins: string | null;
        active: boolean;
        retentionDays: number;
        content: string;
    }): Promise<AudienceSiteRow>;
    update(
        id: number,
        workspaceId: number,
        input: {
            nameRef: string;
            platform: string;
            visitorMode: string;
            origins: string | null;
            active: boolean;
            retentionDays: number;
            content: string;
        }
    ): Promise<AudienceSiteRow | null>;
    /** Renouvelle la clé publique. L'ancienne cesse d'entrer immédiatement. */
    setPublicKey(id: number, workspaceId: number, publicKey: string): Promise<void>;
    remove(id: number, workspaceId: number): Promise<boolean>;
    reorder(workspaceId: number, ids: number[]): Promise<void>;
    /** Les projets qui suivent ce site — le titre reste à déchiffrer. */
    listUsage(siteId: number, workspaceId: number): Promise<AudienceUsageRow[]>;

    // -- liaison projet → site ---------------------------------------------
    listLinkedIds(projectId: number, workspaceId: number): Promise<number[]>;
    link(projectId: number, workspaceId: number, siteId: number): Promise<void>;
    unlink(projectId: number, workspaceId: number, siteId: number): Promise<boolean>;
    unlinkAll(projectId: number, workspaceId: number): Promise<void>;
    findLink(projectId: number, workspaceId: number, siteId: number): Promise<ProjectAudienceLinkRow | null>;

    // -- lectures agrégées --------------------------------------------------
    /** Le bandeau : sessions, visiteurs, durée, rebonds. Les vues à part. */
    metrics(siteId: number, from: number, to: number): Promise<AudienceMetricsRow>;
    /**
     * Visiteurs de la période qui étaient **déjà venus avant**.
     *
     * N'a de sens qu'en mode persistant : en anonyme, `visitor_ref` change de
     * sel chaque jour, donc personne n'est jamais « déjà venu » et la requête
     * rendrait toujours zéro. L'appelant ne la pose donc pas dans ce cas.
     *
     * ⚠️ Bornée par la conservation du site : quelqu'un dont la dernière visite
     * a expiré repasse pour un nouveau. Conséquence de la rétention, pas une
     * erreur de comptage.
     */
    returningVisitors(siteId: number, from: number, to: number): Promise<number>;
    /** La courbe. `origin` aligne les seaux sur le début de la fenêtre. */
    points(siteId: number, from: number, to: number, bucket: number, origin: number): Promise<AudiencePointRow[]>;
    breakdown(
        siteId: number,
        dimension: AudienceDimension,
        from: number,
        to: number,
        limit: number
    ): Promise<AudienceBreakdownRow[]>;
    /** La carte jour × heure, en heure **locale du visiteur**. */
    activity(siteId: number, from: number, to: number): Promise<AudienceActivityRow[]>;
    /** Visiteurs distincts vus depuis `since`, et les pages qu'ils regardent. */
    liveVisitors(siteId: number, since: number): Promise<number>;
    livePages(siteId: number, since: number, limit: number): Promise<AudienceBreakdownRow[]>;
}

export function audienceRepo(pool: Q): AudienceRepo {
    /**
     * La fenêtre de « 24 h » des cartes de la liste, calculée en SQL pour que
     * ranger la liste ne demande pas un aller-retour par site.
     */
    const SELECT_WITH_STATS = `
        SELECT s.*,
               (SELECT COUNT(*) FROM project_audience_links l WHERE l.site_id = s.id) AS project_count,
               (SELECT COUNT(*) FROM audience_events e
                 WHERE e.site_id = s.id AND e.kind = 0 AND e.ts >= (UNIX_TIMESTAMP() - 86400)) AS views_24h,
               (SELECT COUNT(DISTINCT v.visitor_ref) FROM audience_sessions v
                 WHERE v.site_id = s.id AND v.last_at >= (UNIX_TIMESTAMP() - 86400)) AS visitors_24h
          FROM audience_sites s`;

    const withNumbers = (row: AudienceSiteWithStatsRow): AudienceSiteWithStatsRow => ({
        ...row,
        project_count: Number(row.project_count),
        views_24h: Number(row.views_24h),
        visitors_24h: Number(row.visitors_24h)
    });

    return {
        async list(workspaceId) {
            const r = await pool.query<AudienceSiteWithStatsRow>(
                `${SELECT_WITH_STATS} WHERE s.workspace_id = ? ORDER BY s.sort_order ASC, s.id ASC`,
                [workspaceId]
            );
            return r.rows.map(withNumbers);
        },
        async find(id, workspaceId) {
            const r = await pool.query<AudienceSiteRow>(
                'SELECT * FROM audience_sites WHERE id = ? AND workspace_id = ?',
                [id, workspaceId]
            );
            return r.rows[0] ?? null;
        },
        async findWithStats(id, workspaceId) {
            const r = await pool.query<AudienceSiteWithStatsRow>(
                `${SELECT_WITH_STATS} WHERE s.id = ? AND s.workspace_id = ?`,
                [id, workspaceId]
            );
            const row = r.rows[0];
            return row ? withNumbers(row) : null;
        },
        async findByName(workspaceId, nameRef) {
            const r = await pool.query<AudienceSiteRow>(
                'SELECT * FROM audience_sites WHERE workspace_id = ? AND name_ref = ?',
                [workspaceId, nameRef]
            );
            return r.rows[0] ?? null;
        },
        async count(workspaceId) {
            const r = await pool.query<{ total: number }>(
                'SELECT COUNT(*) AS total FROM audience_sites WHERE workspace_id = ?',
                [workspaceId]
            );
            return Number(r.rows[0]?.total ?? 0);
        },
        async create(input) {
            // Un nouveau site atterrit à la fin de la liste, jamais au milieu.
            const posRow = await pool.query<{ next: number }>(
                'SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM audience_sites WHERE workspace_id = ?',
                [input.workspaceId]
            );
            const res = await pool.query(
                `INSERT INTO audience_sites
                     (workspace_id, public_key, name_ref, platform, visitor_mode, origins, active,
                      retention_days, sort_order, content)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    input.workspaceId,
                    input.publicKey,
                    input.nameRef,
                    input.platform,
                    input.visitorMode,
                    input.origins,
                    input.active ? 1 : 0,
                    input.retentionDays,
                    Number(posRow.rows[0]?.next ?? 0),
                    input.content
                ]
            );
            const r = await pool.query<AudienceSiteRow>('SELECT * FROM audience_sites WHERE id = ?', [res.insertId]);
            return r.rows[0];
        },
        async update(id, workspaceId, input) {
            const res = await pool.query(
                `UPDATE audience_sites
                    SET name_ref = ?, platform = ?, visitor_mode = ?, origins = ?, active = ?,
                        retention_days = ?, content = ?
                  WHERE id = ? AND workspace_id = ?`,
                [
                    input.nameRef,
                    input.platform,
                    input.visitorMode,
                    input.origins,
                    input.active ? 1 : 0,
                    input.retentionDays,
                    input.content,
                    id,
                    workspaceId
                ]
            );
            if (res.rowCount === 0) return null;
            return this.find(id, workspaceId);
        },
        async setPublicKey(id, workspaceId, publicKey) {
            await pool.query('UPDATE audience_sites SET public_key = ? WHERE id = ? AND workspace_id = ?', [
                publicKey,
                id,
                workspaceId
            ]);
        },
        async remove(id, workspaceId) {
            // Libellés, sessions, événements, agrégat et liaisons partent en
            // CASCADE ; les projets liés, eux, ne perdent qu'un pointeur.
            const r = await pool.query('DELETE FROM audience_sites WHERE id = ? AND workspace_id = ?', [
                id,
                workspaceId
            ]);
            return r.rowCount > 0;
        },
        async reorder(workspaceId, ids) {
            for (let i = 0; i < ids.length; i++) {
                await pool.query('UPDATE audience_sites SET sort_order = ? WHERE id = ? AND workspace_id = ?', [
                    i,
                    ids[i],
                    workspaceId
                ]);
            }
        },
        async listUsage(siteId, workspaceId) {
            const r = await pool.query<AudienceUsageRow>(
                `SELECT p.id AS project_id, p.status, p.content
                   FROM project_audience_links l
                   JOIN projects p ON p.id = l.project_id
                  WHERE l.site_id = ? AND l.workspace_id = ? AND p.archived_at IS NULL
                  ORDER BY p.sort_order ASC, p.id ASC`,
                [siteId, workspaceId]
            );
            return r.rows;
        },

        // -- liaison projet → site -----------------------------------------
        async listLinkedIds(projectId, workspaceId) {
            const r = await pool.query<{ site_id: number }>(
                `SELECT l.site_id
                   FROM project_audience_links l
                   JOIN audience_sites s ON s.id = l.site_id
                  WHERE l.project_id = ? AND l.workspace_id = ?
                  ORDER BY s.sort_order ASC, s.id ASC`,
                [projectId, workspaceId]
            );
            return r.rows.map((row) => Number(row.site_id));
        },
        async link(projectId, workspaceId, siteId) {
            // Idempotente : relier deux fois le même site ne crée pas un doublon.
            await pool.query(
                `INSERT INTO project_audience_links (project_id, site_id, workspace_id)
                 VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE workspace_id = VALUES(workspace_id)`,
                [projectId, siteId, workspaceId]
            );
        },
        async unlink(projectId, workspaceId, siteId) {
            const r = await pool.query(
                'DELETE FROM project_audience_links WHERE project_id = ? AND workspace_id = ? AND site_id = ?',
                [projectId, workspaceId, siteId]
            );
            return r.rowCount > 0;
        },
        async unlinkAll(projectId, workspaceId) {
            await pool.query('DELETE FROM project_audience_links WHERE project_id = ? AND workspace_id = ?', [
                projectId,
                workspaceId
            ]);
        },
        async findLink(projectId, workspaceId, siteId) {
            const r = await pool.query<ProjectAudienceLinkRow>(
                'SELECT * FROM project_audience_links WHERE project_id = ? AND workspace_id = ? AND site_id = ?',
                [projectId, workspaceId, siteId]
            );
            return r.rows[0] ?? null;
        },

        // -- lectures agrégées ----------------------------------------------
        async metrics(siteId, from, to) {
            // Les vues se comptent sur les **faits** et non sur `sessions.views` :
            // une session ouverte avant la fenêtre porterait sinon toutes ses
            // vues dedans, ou aucune, selon le bord. Les trois autres mesures
            // sont par nature de la session, d'où deux requêtes plutôt qu'une.
            const [viewsRow, sessionRow] = await Promise.all([
                pool.query<{ views: number }>(
                    `SELECT COUNT(*) AS views FROM audience_events
                      WHERE site_id = ? AND kind = 0 AND ts >= ? AND ts < ?`,
                    [siteId, from, to]
                ),
                pool.query<{ sessions: number; visitors: number; duration: number; bounces: number }>(
                    `SELECT COUNT(*) AS sessions,
                            COUNT(DISTINCT visitor_ref) AS visitors,
                            COALESCE(SUM(GREATEST(last_at - started_at, 0)), 0) AS duration,
                            COALESCE(SUM(views <= 1), 0) AS bounces
                       FROM audience_sessions
                      WHERE site_id = ? AND started_at >= ? AND started_at < ?`,
                    [siteId, from, to]
                )
            ]);
            const s = sessionRow.rows[0];
            return {
                views: Number(viewsRow.rows[0]?.views ?? 0),
                visitors: Number(s?.visitors ?? 0),
                sessions: Number(s?.sessions ?? 0),
                duration: Number(s?.duration ?? 0),
                bounces: Number(s?.bounces ?? 0)
            };
        },
        async returningVisitors(siteId, from, to) {
            // `idx_audience_sessions_window (site_id, started_at, visitor_ref)`
            // couvre les deux côtés : la fenêtre comme l'antériorité se lisent
            // dans l'index, sans toucher une seule ligne.
            const r = await pool.query<{ total: number }>(
                `SELECT COUNT(DISTINCT s.visitor_ref) AS total
                   FROM audience_sessions s
                  WHERE s.site_id = ? AND s.started_at >= ? AND s.started_at < ?
                    AND s.visitor_ref IN (SELECT p.visitor_ref FROM audience_sessions p
                                           WHERE p.site_id = ? AND p.started_at < ?)`,
                [siteId, from, to, siteId, from]
            );
            return Number(r.rows[0]?.total ?? 0);
        },
        async points(siteId, from, to, bucket, origin) {
            // Les seaux sont alignés sur le **début de la fenêtre**, pas sur
            // l'époque : sans ça, un pas hebdomadaire tomberait un jeudi (epoch
            // 0) et la première colonne serait toujours tronquée.
            const r = await pool.query<AudiencePointRow>(
                `SELECT FLOOR((e.ts - ?) / ?) * ? + ? AS at,
                        COUNT(*) AS views,
                        COUNT(DISTINCT s.visitor_ref) AS visitors
                   FROM audience_events e
                   JOIN audience_sessions s ON s.id = e.session_id
                  WHERE e.site_id = ? AND e.kind = 0 AND e.ts >= ? AND e.ts < ?
                  GROUP BY at
                  ORDER BY at ASC`,
                [origin, bucket, bucket, origin, siteId, from, to]
            );
            return r.rows.map((row) => ({
                at: Number(row.at),
                views: Number(row.views),
                visitors: Number(row.visitors)
            }));
        },
        async breakdown(siteId, dimension, from, to, limit) {
            const source = DIMENSION_SOURCE[dimension];
            const rows =
                source.table === 'event'
                    ? await pool.query<AudienceBreakdownRow>(
                          `SELECT l.content, COUNT(*) AS views, COUNT(DISTINCT s.visitor_ref) AS visitors
                             FROM audience_events e
                             JOIN audience_sessions s ON s.id = e.session_id
                             JOIN audience_labels l ON l.id = e.${source.column}
                            WHERE e.site_id = ? AND e.kind = ? AND e.ts >= ? AND e.ts < ?
                            GROUP BY l.id
                            ORDER BY views DESC, l.id ASC
                            LIMIT ?`,
                          [siteId, source.kind ?? 0, from, to, limit]
                      )
                    : await pool.query<AudienceBreakdownRow>(
                          `SELECT l.content, COALESCE(SUM(s.views), 0) AS views,
                                  COUNT(DISTINCT s.visitor_ref) AS visitors
                             FROM audience_sessions s
                             JOIN audience_labels l ON l.id = s.${source.column}
                            WHERE s.site_id = ? AND s.started_at >= ? AND s.started_at < ?
                            GROUP BY l.id
                            ORDER BY views DESC, l.id ASC
                            LIMIT ?`,
                          [siteId, from, to, limit]
                      );
            return rows.rows.map((row) => ({
                content: row.content,
                views: Number(row.views),
                visitors: Number(row.visitors)
            }));
        },
        async activity(siteId, from, to) {
            // `tz_offset` est celui de `Date.getTimezoneOffset()` : **positif à
            // l'ouest**. L'heure locale est donc `ts - offset * 60`, et non
            // l'inverse. Le jour 0 de l'époque étant un jeudi, `+3` ramène
            // lundi en tête — la semaine à l'européenne, comme partout ailleurs
            // dans l'interface.
            const r = await pool.query<AudienceActivityRow>(
                `SELECT MOD(FLOOR((e.ts - COALESCE(s.tz_offset, 0) * 60) / 86400) + 3, 7) AS day,
                        FLOOR(MOD(e.ts - COALESCE(s.tz_offset, 0) * 60, 86400) / 3600) AS hour,
                        COUNT(*) AS views
                   FROM audience_events e
                   JOIN audience_sessions s ON s.id = e.session_id
                  WHERE e.site_id = ? AND e.kind = 0 AND e.ts >= ? AND e.ts < ?
                  GROUP BY day, hour`,
                [siteId, from, to]
            );
            return r.rows.map((row) => ({
                day: Number(row.day),
                hour: Number(row.hour),
                views: Number(row.views)
            }));
        },
        async liveVisitors(siteId, since) {
            const r = await pool.query<{ total: number }>(
                `SELECT COUNT(DISTINCT visitor_ref) AS total FROM audience_sessions
                  WHERE site_id = ? AND last_at >= ?`,
                [siteId, since]
            );
            return Number(r.rows[0]?.total ?? 0);
        },
        async livePages(siteId, since, limit) {
            const r = await pool.query<AudienceBreakdownRow>(
                `SELECT l.content, COUNT(*) AS views, COUNT(DISTINCT s.visitor_ref) AS visitors
                   FROM audience_events e
                   JOIN audience_sessions s ON s.id = e.session_id
                   JOIN audience_labels l ON l.id = e.path_id
                  WHERE e.site_id = ? AND e.kind = 0 AND e.ts >= ?
                  GROUP BY l.id
                  ORDER BY views DESC, l.id ASC
                  LIMIT ?`,
                [siteId, since, limit]
            );
            return r.rows.map((row) => ({
                content: row.content,
                views: Number(row.views),
                visitors: Number(row.visitors)
            }));
        }
    };
}
