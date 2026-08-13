import type { AudienceSiteRow } from 'deveye-types';
import type { Queryable } from '../pool';

type Q = Queryable;

/** Une session ouverte, telle que l'ingestion a besoin de la connaître. */
export interface OpenSessionRow {
    id: number;
    views: number;
    identity_id: number | null;
}

/** Ce qu'on sait d'un visiteur au moment où sa session s'ouvre. */
export interface NewSessionInput {
    siteId: number;
    visitorRef: string;
    at: number;
    entryPathId: number | null;
    referrerId: number | null;
    browserId: number | null;
    osId: number | null;
    deviceId: number | null;
    timezoneId: number | null;
    languageId: number | null;
    identityId: number | null;
    tzOffset: number | null;
    screenWidth: number | null;
}

/** Un fait, prêt à être écrit. */
export interface PendingEventRow {
    siteId: number;
    sessionId: number;
    ts: number;
    kind: number;
    pathId: number | null;
    nameId: number | null;
}

/** Ce que la maintenance a besoin de savoir d'un site, et rien de plus. */
export interface AudienceMaintenanceRow {
    id: number;
    workspace_id: number;
    retention_days: number;
}

/**
 * Le **chemin chaud** de l'audience : ce que l'ingestion publique écrit.
 *
 * Séparé d'`audience.ts` exprès. Les deux touchent les mêmes tables, mais pas
 * du tout au même rythme — celui-ci tourne à chaque page vue de chaque site de
 * chaque espace, sans session utilisateur, depuis une requête HTTP anonyme.
 * Les mélanger aurait fait cohabiter des requêtes qu'on optimise et des
 * requêtes qu'on écrit pour être lues.
 *
 * Rien ici ne déchiffre : le service qui l'appelle tient les caches, et ces
 * méthodes ne manipulent que des entiers et des condensés.
 */
export interface AudienceIngestRepo {
    /**
     * Le site derrière une clé publique. **Sans espace en paramètre** — c'est
     * tout l'objet de la clé : l'ingestion arrive sans session, sans cookie et
     * sans enveloppe, elle n'a que ça pour savoir où écrire.
     */
    findByPublicKey(publicKey: string): Promise<AudienceSiteRow | null>;
    /**
     * L'identifiant d'un libellé, créé au besoin.
     *
     * `ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)` rend l'identifiant
     * existant sans seconde requête ni course entre deux requêtes simultanées.
     * `content` n'est **jamais** réécrit : le chiffrement étant non
     * déterministe, le réécrire produirait un octet différent à chaque visite
     * pour exactement la même valeur.
     */
    resolveLabel(siteId: number, kind: string, labelRef: string, content: string): Promise<number>;
    /** La session encore ouverte de ce visiteur, s'il y en a une. */
    findOpenSession(siteId: number, visitorRef: string, since: number): Promise<OpenSessionRow | null>;
    createSession(input: NewSessionInput): Promise<number>;
    /** Prolonge une session et lui ajoute ses vues. */
    touchSession(id: number, at: number, viewsDelta: number): Promise<void>;
    /**
     * Rattache une identité à une session déjà ouverte.
     *
     * Le cas courant : on arrive anonyme, on se connecte, et le site ne peut
     * nommer son utilisateur qu'à partir de là. Sans ceci, toute visite
     * commencerait anonyme et le resterait.
     */
    setSessionIdentity(id: number, identityId: number): Promise<void>;
    insertEvents(rows: PendingEventRow[]): Promise<void>;
    /** Le dernier événement reçu, ce que l'écran d'installation guette. */
    touchSite(siteId: number, at: number): Promise<void>;

    // -- maintenance --------------------------------------------------------
    listForMaintenance(): Promise<AudienceMaintenanceRow[]>;
    /**
     * Fige un jour dans l'agrégat. Rejouable : le même jour recalculé écrase
     * l'ancien, ce qui rend la tâche de fond sans conséquence si elle repasse.
     */
    rollupDay(siteId: number, day: number, from: number, to: number): Promise<void>;
    /**
     * Purge les faits antérieurs à `before`. Les événements d'abord, les
     * sessions ensuite : l'inverse buterait sur la clé étrangère.
     */
    pruneEvents(siteId: number, before: number): Promise<number>;
    pruneSessions(siteId: number, before: number): Promise<number>;
    /**
     * Les libellés que plus aucun fait ne cite.
     *
     * Sans ce ménage, la table de dimensions ne décroîtrait jamais : un chemin
     * disparu du site resterait pour toujours, et se présenterait à chaque
     * conversion de clé d'espace.
     */
    pruneOrphanLabels(siteId: number): Promise<number>;
}

export function audienceIngestRepo(pool: Q): AudienceIngestRepo {
    return {
        async findByPublicKey(publicKey) {
            const r = await pool.query<AudienceSiteRow>('SELECT * FROM audience_sites WHERE public_key = ?', [
                publicKey
            ]);
            return r.rows[0] ?? null;
        },
        async resolveLabel(siteId, kind, labelRef, content) {
            const res = await pool.query(
                `INSERT INTO audience_labels (site_id, kind, label_ref, content)
                 VALUES (?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
                [siteId, kind, labelRef, content]
            );
            return Number(res.insertId);
        },
        async findOpenSession(siteId, visitorRef, since) {
            const r = await pool.query<OpenSessionRow>(
                `SELECT id, views, identity_id FROM audience_sessions
                  WHERE site_id = ? AND visitor_ref = ? AND last_at >= ?
                  ORDER BY last_at DESC LIMIT 1`,
                [siteId, visitorRef, since]
            );
            const row = r.rows[0];
            return row ? { ...row, id: Number(row.id), views: Number(row.views) } : null;
        },
        async createSession(input) {
            const res = await pool.query(
                `INSERT INTO audience_sessions
                     (site_id, visitor_ref, started_at, last_at, views, entry_path_id, referrer_id,
                      browser_id, os_id, device_id, timezone_id, language_id, identity_id,
                      tz_offset, screen_width)
                 VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    input.siteId,
                    input.visitorRef,
                    input.at,
                    input.at,
                    input.entryPathId,
                    input.referrerId,
                    input.browserId,
                    input.osId,
                    input.deviceId,
                    input.timezoneId,
                    input.languageId,
                    input.identityId,
                    input.tzOffset,
                    input.screenWidth
                ]
            );
            return Number(res.insertId);
        },
        async touchSession(id, at, viewsDelta) {
            // `GREATEST` : un client natif peut livrer un lot dans le désordre
            // après une coupure, et `last_at` ne doit jamais reculer — la durée
            // de la session en deviendrait négative.
            await pool.query(
                'UPDATE audience_sessions SET last_at = GREATEST(last_at, ?), views = views + ? WHERE id = ?',
                [at, viewsDelta, id]
            );
        },
        async setSessionIdentity(id, identityId) {
            await pool.query('UPDATE audience_sessions SET identity_id = ? WHERE id = ?', [identityId, id]);
        },
        async insertEvents(rows) {
            if (rows.length === 0) return;
            const placeholders = rows.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
            const params: unknown[] = [];
            for (const row of rows) {
                params.push(row.siteId, row.sessionId, row.ts, row.kind, row.pathId, row.nameId);
            }
            await pool.query(
                `INSERT INTO audience_events (site_id, session_id, ts, kind, path_id, name_id)
                 VALUES ${placeholders}`,
                params
            );
        },
        async touchSite(siteId, at) {
            await pool.query(
                'UPDATE audience_sites SET last_event_at = GREATEST(COALESCE(last_event_at, 0), ?) WHERE id = ?',
                [at, siteId]
            );
        },

        // -- maintenance ----------------------------------------------------
        async listForMaintenance() {
            const r = await pool.query<AudienceMaintenanceRow>(
                'SELECT id, workspace_id, retention_days FROM audience_sites ORDER BY id ASC'
            );
            return r.rows.map((row) => ({
                id: Number(row.id),
                workspace_id: Number(row.workspace_id),
                retention_days: Number(row.retention_days)
            }));
        },
        async rollupDay(siteId, day, from, to) {
            const [views, sessions] = await Promise.all([
                pool.query<{ total: number }>(
                    'SELECT COUNT(*) AS total FROM audience_events WHERE site_id = ? AND kind = 0 AND ts >= ? AND ts < ?',
                    [siteId, from, to]
                ),
                pool.query<{ total: number; visitors: number }>(
                    `SELECT COUNT(*) AS total, COUNT(DISTINCT visitor_ref) AS visitors
                       FROM audience_sessions WHERE site_id = ? AND started_at >= ? AND started_at < ?`,
                    [siteId, from, to]
                )
            ]);
            await pool.query(
                `INSERT INTO audience_daily (site_id, day, views, sessions, visitors)
                 VALUES (?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE views = VALUES(views), sessions = VALUES(sessions),
                                         visitors = VALUES(visitors)`,
                [
                    siteId,
                    day,
                    Number(views.rows[0]?.total ?? 0),
                    Number(sessions.rows[0]?.total ?? 0),
                    Number(sessions.rows[0]?.visitors ?? 0)
                ]
            );
        },
        async pruneEvents(siteId, before) {
            const r = await pool.query('DELETE FROM audience_events WHERE site_id = ? AND ts < ?', [siteId, before]);
            return r.rowCount;
        },
        async pruneSessions(siteId, before) {
            const r = await pool.query('DELETE FROM audience_sessions WHERE site_id = ? AND last_at < ?', [
                siteId,
                before
            ]);
            return r.rowCount;
        },
        async pruneOrphanLabels(siteId) {
            // Dix colonnes peuvent citer un libellé. La forme naturelle —
            // `NOT EXISTS (… WHERE e.path_id = l.id OR …)` — est un piège : la
            // sous-requête est **corrélée**, donc rejouée pour chaque libellé,
            // et sur des colonnes qu'aucun index ne couvre. Un site à trois
            // cents libellés y parcourrait trois cents fois sa table de faits.
            //
            // La forme ensembliste ci-dessous est matérialisée **une fois** :
            // chaque sous-requête est bornée par `site_id`, et les deux plus
            // grosses sont servies entièrement par `idx_audience_events_window`
            // (qui porte `path_id` et `name_id` justement pour ça).
            //
            // ⚠️ `IS NOT NULL` dans chaque sous-requête n'est pas décoratif :
            // `NOT IN` face à un seul NULL ne rend **jamais** vrai, et le ménage
            // ne supprimerait alors rien, en silence et pour toujours.
            const r = await pool.query(
                `DELETE l FROM audience_labels l
                  WHERE l.site_id = ?
                    AND l.id NOT IN (SELECT path_id FROM audience_events
                                      WHERE site_id = ? AND path_id IS NOT NULL)
                    AND l.id NOT IN (SELECT name_id FROM audience_events
                                      WHERE site_id = ? AND name_id IS NOT NULL)
                    AND l.id NOT IN (SELECT entry_path_id FROM audience_sessions
                                      WHERE site_id = ? AND entry_path_id IS NOT NULL)
                    AND l.id NOT IN (SELECT referrer_id FROM audience_sessions
                                      WHERE site_id = ? AND referrer_id IS NOT NULL)
                    AND l.id NOT IN (SELECT browser_id FROM audience_sessions
                                      WHERE site_id = ? AND browser_id IS NOT NULL)
                    AND l.id NOT IN (SELECT os_id FROM audience_sessions
                                      WHERE site_id = ? AND os_id IS NOT NULL)
                    AND l.id NOT IN (SELECT device_id FROM audience_sessions
                                      WHERE site_id = ? AND device_id IS NOT NULL)
                    AND l.id NOT IN (SELECT timezone_id FROM audience_sessions
                                      WHERE site_id = ? AND timezone_id IS NOT NULL)
                    AND l.id NOT IN (SELECT language_id FROM audience_sessions
                                      WHERE site_id = ? AND language_id IS NOT NULL)
                    AND l.id NOT IN (SELECT identity_id FROM audience_sessions
                                      WHERE site_id = ? AND identity_id IS NOT NULL)`,
                Array.from({ length: 11 }, () => siteId)
            );
            return r.rowCount;
        }
    };
}
