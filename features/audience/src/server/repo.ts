import type { AudienceDimension, AudienceFunnelRow, AudienceFunnelStepRow, AudienceSiteRow } from '../contracts/domain';
import { AUDIENCE_FUNNEL_MAX_STEPS } from '../contracts/domain';
import type { SdkQueryable } from '@deveye/types/sdk/server';

/**
 * Un site, plus ce que ses tables voisines en disent.
 *
 * Le nombre de projets qui s'en servent n'en fait plus partie : la table de
 * liaison (`project_audience_links`) appartient à Projets, et le module ne lit
 * aucune table de Projets. Le compte vient de son contrat
 * (`PROJECTS_USAGE_PROVIDER`), et `toSite` le reçoit en paramètre.
 */
export interface AudienceSiteWithStatsRow extends AudienceSiteRow {
    views_24h: number;
    visitors_24h: number;
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

/** Une marche résolue : ce qu'elle reconnaît, et l'identifiant du libellé. */
export interface ResolvedStep {
    kind: 'path' | 'event';
    /** `null` quand le site n'a **jamais** émis cette valeur. La marche vaut 0. */
    labelId: number | null;
}

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
 * Où vit chaque dimension, et sous quelle colonne.
 *
 * ⚠️ **C'est la seule table qui nomme une colonne dans une requête**, et c'est
 * délibérément une constante fermée : un nom de colonne ne peut pas être un
 * paramètre lié, il faut bien l'écrire dans le texte SQL. La discipline est
 * celle de `features/database/src/server/explore.ts` — on n'utilise jamais l'identifiant
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
 * Les sites suivis de l'espace, tout ce qu'on lit d'eux, leurs entonnoirs, et
 * ce que l'ingestion publique écrit.
 *
 * Trois dépôts natifs (`db/repos/audience.ts`, `audienceFunnels.ts`,
 * `audienceIngest.ts`) réunis en un seul contrat depuis le rapatriement en
 * module, parce que le SDK n'en construit qu'un par module ; les trois
 * sections gardent leur frontière, et il faut la connaître.
 *
 * **Le chemin froid** (sites et lectures agrégées) sert les écrans, quelques
 * fois par minute au plus. **Le chemin chaud** (la section « ingestion ») tourne
 * à chaque page vue de chaque site de chaque espace, sans session utilisateur,
 * depuis une requête HTTP anonyme : les mêmes tables, mais aucune des mêmes
 * contraintes. Les mélanger aurait fait cohabiter des requêtes qu'on optimise
 * et des requêtes qu'on écrit pour être lues. Rien n'y déchiffre : le service
 * qui l'appelle tient les caches, et ces méthodes ne manipulent que des
 * entiers et des condensés.
 *
 * Tout est à l'étage **ouvert** : un site appartient à l'espace, sert des
 * projets de paliers différents, et ne peut donc suivre aucun d'eux.
 *
 * Les liaisons vers les projets (`project_audience_links`) et la liste des
 * projets qui suivent un site ont rejoint `db/repos/projectLinks.ts` dans
 * l'app : c'est une table de Projets, que le module ne lit pas. Ce qu'il a
 * besoin d'en savoir lui vient du contrat `PROJECTS_USAGE_PROVIDER`.
 */
export interface AudienceRepo {
    // -- sites --------------------------------------------------------------
    list(workspaceId: number): Promise<AudienceSiteWithStatsRow[]>;
    /** Comme `list`, plus les sites projetés vers cet espace. */
    listVisible(workspaceId: number): Promise<AudienceSiteWithStatsRow[]>;
    find(id: number, workspaceId: number): Promise<AudienceSiteRow | null>;
    /** Comme `find`, mais accepte aussi un site projeté vers cet espace. */
    findVisible(id: number, workspaceId: number): Promise<AudienceSiteRow | null>;
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

    // -- entonnoirs ---------------------------------------------------------
    /**
     * Les entonnoirs d'un site : leur définition, et la rétention marche par
     * marche. Une section à part parce que sa seule requête intéressante l'est
     * vraiment — voir {@link AudienceRepo.retention}. Le reste n'est que du
     * rangement.
     */
    listFunnels(siteId: number): Promise<AudienceFunnelRow[]>;
    listFunnelSteps(siteId: number): Promise<AudienceFunnelStepRow[]>;
    /** L'entonnoir **et** son espace : la frontière d'accès de la feature. */
    findFunnelInWorkspace(funnelId: number, workspaceId: number): Promise<AudienceFunnelRow | null>;
    findFunnelByName(siteId: number, nameRef: string): Promise<AudienceFunnelRow | null>;
    countFunnels(siteId: number): Promise<number>;
    createFunnel(input: { siteId: number; nameRef: string; content: string }): Promise<number>;
    renameFunnel(funnelId: number, nameRef: string, content: string): Promise<void>;
    removeFunnel(funnelId: number): Promise<boolean>;
    /**
     * Remplace **toutes** les marches d'un entonnoir.
     *
     * Remplacer plutôt que rapiécer : une marche n'a pas d'identité propre — on
     * ne renomme pas la troisième marche, on redéfinit le parcours. Un `UPDATE`
     * ligne à ligne aurait demandé de suivre des identifiants que personne ne
     * regarde, pour le même résultat.
     */
    replaceFunnelSteps(
        funnelId: number,
        siteId: number,
        steps: { kind: string; labelRef: string; content: string }[]
    ): Promise<void>;
    /** Les libellés du site qui correspondent à ces condensés, s'ils existent. */
    resolveLabels(siteId: number, refs: { kind: string; labelRef: string }[]): Promise<Map<string, number>>;
    /** Visites arrivées à chaque marche, les précédentes franchies **dans l'ordre**. */
    retention(siteId: number, steps: ResolvedStep[], from: number, to: number): Promise<number[]>;

    // -- ingestion (le chemin chaud) ----------------------------------------
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
     * disparu du site y resterait pour toujours.
     */
    pruneOrphanLabels(siteId: number): Promise<number>;
}

/**
 * La fenêtre de « 24 h » des cartes de la liste, calculée en SQL pour que
 * ranger la liste ne demande pas un aller-retour par site. Le nombre de
 * projets, qui était la première colonne, vient désormais du contrat de
 * Projets.
 */
const SELECT_WITH_STATS = `
    SELECT s.*,
           (SELECT COUNT(*) FROM audience_events e
             WHERE e.site_id = s.id AND e.kind = 0 AND e.ts >= (UNIX_TIMESTAMP() - 86400)) AS views_24h,
           (SELECT COUNT(DISTINCT v.visitor_ref) FROM audience_sessions v
             WHERE v.site_id = s.id AND v.last_at >= (UNIX_TIMESTAMP() - 86400)) AS visitors_24h
      FROM audience_sites s`;

const withNumbers = (row: AudienceSiteWithStatsRow): AudienceSiteWithStatsRow => ({
    ...row,
    views_24h: Number(row.views_24h),
    visitors_24h: Number(row.visitors_24h)
});

export function createRepo(q: SdkQueryable): AudienceRepo {
    async function find(id: number, workspaceId: number): Promise<AudienceSiteRow | null> {
        const rows = await q.query<AudienceSiteRow>('SELECT * FROM audience_sites WHERE id = ? AND workspace_id = ?', [
            id,
            workspaceId
        ]);
        return rows[0] ?? null;
    }

    return {
        // -- sites ----------------------------------------------------------
        async list(workspaceId) {
            const rows = await q.query<AudienceSiteWithStatsRow>(
                `${SELECT_WITH_STATS} WHERE s.workspace_id = ? ORDER BY s.sort_order ASC, s.id ASC`,
                [workspaceId]
            );
            return rows.map(withNumbers);
        },
        async listVisible(workspaceId) {
            const rows = await q.query<AudienceSiteWithStatsRow>(
                `${SELECT_WITH_STATS} WHERE s.workspace_id = ?
                 UNION
                 ${SELECT_WITH_STATS}
                  JOIN item_shares sh
                    ON sh.feature = 'audience' AND sh.item_id = s.id AND sh.home_workspace_id = s.workspace_id
                 WHERE sh.workspace_id = ?
                 ORDER BY sort_order ASC, id ASC`,
                [workspaceId, workspaceId]
            );
            return rows.map(withNumbers);
        },
        find,
        async findVisible(id, workspaceId) {
            const rows = await q.query<AudienceSiteRow>(
                `SELECT s.* FROM audience_sites s
                  WHERE s.id = ?
                    AND (s.workspace_id = ?
                         OR EXISTS (SELECT 1 FROM item_shares sh
                                     WHERE sh.feature = 'audience' AND sh.item_id = s.id
                                       AND sh.home_workspace_id = s.workspace_id
                                       AND sh.workspace_id = ?))`,
                [id, workspaceId, workspaceId]
            );
            return rows[0] ?? null;
        },
        async findWithStats(id, workspaceId) {
            const rows = await q.query<AudienceSiteWithStatsRow>(
                `${SELECT_WITH_STATS} WHERE s.id = ? AND s.workspace_id = ?`,
                [id, workspaceId]
            );
            const row = rows[0];
            return row ? withNumbers(row) : null;
        },
        async findByName(workspaceId, nameRef) {
            const rows = await q.query<AudienceSiteRow>(
                'SELECT * FROM audience_sites WHERE workspace_id = ? AND name_ref = ?',
                [workspaceId, nameRef]
            );
            return rows[0] ?? null;
        },
        async count(workspaceId) {
            const rows = await q.query<{ total: number }>(
                'SELECT COUNT(*) AS total FROM audience_sites WHERE workspace_id = ?',
                [workspaceId]
            );
            return Number(rows[0]?.total ?? 0);
        },
        async create(input) {
            // Un nouveau site atterrit à la fin de la liste, jamais au milieu.
            const posRows = await q.query<{ next: number }>(
                'SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM audience_sites WHERE workspace_id = ?',
                [input.workspaceId]
            );
            const res = await q.execute(
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
                    Number(posRows[0]?.next ?? 0),
                    input.content
                ]
            );
            const rows = await q.query<AudienceSiteRow>('SELECT * FROM audience_sites WHERE id = ?', [res.insertId]);
            return rows[0];
        },
        async update(id, workspaceId, input) {
            const res = await q.execute(
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
            if (res.affectedRows === 0) return null;
            return find(id, workspaceId);
        },
        async setPublicKey(id, workspaceId, publicKey) {
            await q.execute('UPDATE audience_sites SET public_key = ? WHERE id = ? AND workspace_id = ?', [
                publicKey,
                id,
                workspaceId
            ]);
        },
        async remove(id, workspaceId) {
            // Libellés, sessions, événements, agrégat et liaisons partent en
            // CASCADE ; les projets liés, eux, ne perdent qu'un pointeur.
            const res = await q.execute('DELETE FROM audience_sites WHERE id = ? AND workspace_id = ?', [
                id,
                workspaceId
            ]);
            return res.affectedRows > 0;
        },
        async reorder(workspaceId, ids) {
            for (let i = 0; i < ids.length; i++) {
                await q.execute('UPDATE audience_sites SET sort_order = ? WHERE id = ? AND workspace_id = ?', [
                    i,
                    ids[i],
                    workspaceId
                ]);
            }
        },

        // -- lectures agrégées ----------------------------------------------
        async metrics(siteId, from, to) {
            // Les vues se comptent sur les **faits** et non sur `sessions.views` :
            // une session ouverte avant la fenêtre porterait sinon toutes ses
            // vues dedans, ou aucune, selon le bord. Les trois autres mesures
            // sont par nature de la session, d'où deux requêtes plutôt qu'une.
            const [viewsRows, sessionRows] = await Promise.all([
                q.query<{ views: number }>(
                    `SELECT COUNT(*) AS views FROM audience_events
                      WHERE site_id = ? AND kind = 0 AND ts >= ? AND ts < ?`,
                    [siteId, from, to]
                ),
                q.query<{ sessions: number; visitors: number; duration: number; bounces: number }>(
                    `SELECT COUNT(*) AS sessions,
                            COUNT(DISTINCT visitor_ref) AS visitors,
                            COALESCE(SUM(GREATEST(last_at - started_at, 0)), 0) AS duration,
                            COALESCE(SUM(views <= 1), 0) AS bounces
                       FROM audience_sessions
                      WHERE site_id = ? AND started_at >= ? AND started_at < ?`,
                    [siteId, from, to]
                )
            ]);
            const s = sessionRows[0];
            return {
                views: Number(viewsRows[0]?.views ?? 0),
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
            const rows = await q.query<{ total: number }>(
                `SELECT COUNT(DISTINCT s.visitor_ref) AS total
                   FROM audience_sessions s
                  WHERE s.site_id = ? AND s.started_at >= ? AND s.started_at < ?
                    AND s.visitor_ref IN (SELECT p.visitor_ref FROM audience_sessions p
                                           WHERE p.site_id = ? AND p.started_at < ?)`,
                [siteId, from, to, siteId, from]
            );
            return Number(rows[0]?.total ?? 0);
        },
        async points(siteId, from, to, bucket, origin) {
            // Les seaux sont alignés sur le **début de la fenêtre**, pas sur
            // l'époque : sans ça, un pas hebdomadaire tomberait un jeudi (epoch
            // 0) et la première colonne serait toujours tronquée.
            const rows = await q.query<AudiencePointRow>(
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
            return rows.map((row) => ({
                at: Number(row.at),
                views: Number(row.views),
                visitors: Number(row.visitors)
            }));
        },
        async breakdown(siteId, dimension, from, to, limit) {
            const source = DIMENSION_SOURCE[dimension];
            const rows =
                source.table === 'event'
                    ? await q.query<AudienceBreakdownRow>(
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
                    : await q.query<AudienceBreakdownRow>(
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
            return rows.map((row) => ({
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
            const rows = await q.query<AudienceActivityRow>(
                `SELECT MOD(FLOOR((e.ts - COALESCE(s.tz_offset, 0) * 60) / 86400) + 3, 7) AS day,
                        FLOOR(MOD(e.ts - COALESCE(s.tz_offset, 0) * 60, 86400) / 3600) AS hour,
                        COUNT(*) AS views
                   FROM audience_events e
                   JOIN audience_sessions s ON s.id = e.session_id
                  WHERE e.site_id = ? AND e.kind = 0 AND e.ts >= ? AND e.ts < ?
                  GROUP BY day, hour`,
                [siteId, from, to]
            );
            return rows.map((row) => ({
                day: Number(row.day),
                hour: Number(row.hour),
                views: Number(row.views)
            }));
        },
        async liveVisitors(siteId, since) {
            const rows = await q.query<{ total: number }>(
                `SELECT COUNT(DISTINCT visitor_ref) AS total FROM audience_sessions
                  WHERE site_id = ? AND last_at >= ?`,
                [siteId, since]
            );
            return Number(rows[0]?.total ?? 0);
        },
        async livePages(siteId, since, limit) {
            const rows = await q.query<AudienceBreakdownRow>(
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
            return rows.map((row) => ({
                content: row.content,
                views: Number(row.views),
                visitors: Number(row.visitors)
            }));
        },

        // -- entonnoirs -----------------------------------------------------
        async listFunnels(siteId) {
            return q.query<AudienceFunnelRow>(
                'SELECT * FROM audience_funnels WHERE site_id = ? ORDER BY sort_order ASC, id ASC',
                [siteId]
            );
        },
        async listFunnelSteps(siteId) {
            return q.query<AudienceFunnelStepRow>(
                'SELECT * FROM audience_funnel_steps WHERE site_id = ? ORDER BY funnel_id ASC, position ASC',
                [siteId]
            );
        },
        async findFunnelInWorkspace(funnelId, workspaceId) {
            // La jointure **est** la garde : un entonnoir d'un autre espace n'a
            // pas à exister pour l'appelant, pas même comme refus distinct.
            const rows = await q.query<AudienceFunnelRow>(
                `SELECT f.* FROM audience_funnels f
                   JOIN audience_sites s ON s.id = f.site_id
                  WHERE f.id = ? AND s.workspace_id = ?`,
                [funnelId, workspaceId]
            );
            return rows[0] ?? null;
        },
        async findFunnelByName(siteId, nameRef) {
            const rows = await q.query<AudienceFunnelRow>(
                'SELECT * FROM audience_funnels WHERE site_id = ? AND name_ref = ?',
                [siteId, nameRef]
            );
            return rows[0] ?? null;
        },
        async countFunnels(siteId) {
            const rows = await q.query<{ total: number }>(
                'SELECT COUNT(*) AS total FROM audience_funnels WHERE site_id = ?',
                [siteId]
            );
            return Number(rows[0]?.total ?? 0);
        },
        async createFunnel(input) {
            const posRows = await q.query<{ next: number }>(
                'SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM audience_funnels WHERE site_id = ?',
                [input.siteId]
            );
            const res = await q.execute(
                'INSERT INTO audience_funnels (site_id, name_ref, sort_order, content) VALUES (?, ?, ?, ?)',
                [input.siteId, input.nameRef, Number(posRows[0]?.next ?? 0), input.content]
            );
            return Number(res.insertId);
        },
        async renameFunnel(funnelId, nameRef, content) {
            await q.execute('UPDATE audience_funnels SET name_ref = ?, content = ? WHERE id = ?', [
                nameRef,
                content,
                funnelId
            ]);
        },
        async removeFunnel(funnelId) {
            // Les marches partent en CASCADE. Aucune mesure n'est touchée : un
            // entonnoir ne collecte rien, il relit.
            const res = await q.execute('DELETE FROM audience_funnels WHERE id = ?', [funnelId]);
            return res.affectedRows > 0;
        },
        async replaceFunnelSteps(funnelId, siteId, steps) {
            await q.execute('DELETE FROM audience_funnel_steps WHERE funnel_id = ?', [funnelId]);
            if (steps.length === 0) return;
            const placeholders = steps.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
            const params: unknown[] = [];
            steps.forEach((step, index) => {
                params.push(funnelId, siteId, index, step.kind, step.labelRef, step.content);
            });
            await q.execute(
                `INSERT INTO audience_funnel_steps (funnel_id, site_id, position, match_kind, label_ref, content)
                 VALUES ${placeholders}`,
                params
            );
        },
        async resolveLabels(siteId, refs) {
            if (refs.length === 0) return new Map();
            const placeholders = refs.map(() => '?').join(', ');
            const rows = await q.query<{ id: number; kind: string; label_ref: string }>(
                `SELECT id, kind, label_ref FROM audience_labels
                  WHERE site_id = ? AND label_ref IN (${placeholders})`,
                [siteId, ...refs.map((ref) => ref.labelRef)]
            );
            // Indexé sur `kind:ref` et non sur le seul condensé : le même texte
            // peut parfaitement être à la fois un chemin et un nom d'événement,
            // et ce sont alors deux libellés distincts.
            const byKey = new Map<string, number>();
            for (const row of rows) byKey.set(`${row.kind}:${row.label_ref}`, Number(row.id));
            return byKey;
        },
        async retention(siteId, steps, from, to) {
            if (steps.length === 0) return [];

            // Une marche sans libellé n'a jamais été atteinte : elle vaut zéro,
            // et tout ce qui la suit aussi. On coupe ici plutôt que de laisser
            // la requête le découvrir, ce qui revient au même en moins clair.
            const firstMissing = steps.findIndex((step) => step.labelId === null);
            const measurable = firstMissing === -1 ? steps : steps.slice(0, firstMissing);
            if (measurable.length === 0) return steps.map(() => 0);

            // ⚠️ Les seules parties **interpolées** sont un indice de colonne
            // (`t1`, `t2`…) et le nom d'une colonne d'événement, tirés d'un
            // vocabulaire fermé et bornés par `AUDIENCE_FUNNEL_MAX_STEPS`. Les
            // identifiants de libellés, eux, sont liés. C'est la discipline de
            // `DIMENSION_SOURCE` : on ne met dans le texte de la requête que ce
            // que le serveur a lui-même écrit.
            const n = Math.min(measurable.length, AUDIENCE_FUNNEL_MAX_STEPS);
            const params: unknown[] = [];

            const firsts = measurable.slice(0, n).map((step, i) => {
                const column = step.kind === 'path' ? 'path_id' : 'name_id';
                const eventKind = step.kind === 'path' ? 0 : 1;
                params.push(eventKind, step.labelId);
                // La **première** occurrence de chaque marche : c'est la règle,
                // et elle doit être dite. Un visiteur qui revient en arrière puis
                // repart peut donc ne pas être compté comme converti — le prix
                // d'une définition déterministe qui tient en une requête.
                return `MIN(CASE WHEN e.kind = ? AND e.${column} = ? THEN e.ts END) AS t${i + 1}`;
            });

            // La condition de la marche i : toutes les précédentes présentes, et
            // dans l'ordre. Construite par accumulation, exactement comme on la
            // lit — « arrivé jusqu'ici » veut dire « et pas autrement ».
            //
            // ⚠️ **`>=` et non `>`, et ce n'est pas une facilité.** Nos
            // horodatages sont à la seconde, et le script groupe ses envois sur
            // une demi-seconde : un même clic produit couramment une vue et un
            // événement **dans la même seconde**. Avec `>`, tout entonnoir dont
            // deux marches consécutives naissent du même geste — « ouvrir
            // /devis » puis « devis-ouvert » — compterait zéro conversion, sans
            // rien pour l'expliquer.
            const conditions: string[] = [];
            let chain = 't1 IS NOT NULL';
            conditions.push(chain);
            for (let i = 2; i <= n; i++) {
                chain += ` AND t${i} IS NOT NULL AND t${i} >= t${i - 1}`;
                conditions.push(chain);
            }
            const sums = conditions.map((cond, i) => `COALESCE(SUM(${cond}), 0) AS s${i + 1}`);

            params.push(siteId, from, to);

            const rows = await q.query<Record<string, number>>(
                `SELECT ${sums.join(', ')}
                   FROM (SELECT e.session_id, ${firsts.join(', ')}
                           FROM audience_events e
                          WHERE e.site_id = ? AND e.ts >= ? AND e.ts < ?
                          GROUP BY e.session_id) x`,
                params
            );

            const row = rows[0];
            const counts = measurable.slice(0, n).map((_, i) => Number(row?.[`s${i + 1}`] ?? 0));
            // Les marches coupées plus haut reprennent leur place, à zéro.
            while (counts.length < steps.length) counts.push(0);
            return counts;
        },

        // -- ingestion (le chemin chaud) ------------------------------------
        async findByPublicKey(publicKey) {
            const rows = await q.query<AudienceSiteRow>('SELECT * FROM audience_sites WHERE public_key = ?', [
                publicKey
            ]);
            return rows[0] ?? null;
        },
        async resolveLabel(siteId, kind, labelRef, content) {
            const res = await q.execute(
                `INSERT INTO audience_labels (site_id, kind, label_ref, content)
                 VALUES (?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
                [siteId, kind, labelRef, content]
            );
            return Number(res.insertId);
        },
        async findOpenSession(siteId, visitorRef, since) {
            const rows = await q.query<OpenSessionRow>(
                `SELECT id, views, identity_id FROM audience_sessions
                  WHERE site_id = ? AND visitor_ref = ? AND last_at >= ?
                  ORDER BY last_at DESC LIMIT 1`,
                [siteId, visitorRef, since]
            );
            const row = rows[0];
            return row ? { ...row, id: Number(row.id), views: Number(row.views) } : null;
        },
        async createSession(input) {
            const res = await q.execute(
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
            await q.execute(
                'UPDATE audience_sessions SET last_at = GREATEST(last_at, ?), views = views + ? WHERE id = ?',
                [at, viewsDelta, id]
            );
        },
        async setSessionIdentity(id, identityId) {
            await q.execute('UPDATE audience_sessions SET identity_id = ? WHERE id = ?', [identityId, id]);
        },
        async insertEvents(rows) {
            if (rows.length === 0) return;
            const placeholders = rows.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
            const params: unknown[] = [];
            for (const row of rows) {
                params.push(row.siteId, row.sessionId, row.ts, row.kind, row.pathId, row.nameId);
            }
            await q.execute(
                `INSERT INTO audience_events (site_id, session_id, ts, kind, path_id, name_id)
                 VALUES ${placeholders}`,
                params
            );
        },
        async touchSite(siteId, at) {
            await q.execute(
                'UPDATE audience_sites SET last_event_at = GREATEST(COALESCE(last_event_at, 0), ?) WHERE id = ?',
                [at, siteId]
            );
        },

        // -- maintenance ----------------------------------------------------
        async listForMaintenance() {
            const rows = await q.query<AudienceMaintenanceRow>(
                'SELECT id, workspace_id, retention_days FROM audience_sites ORDER BY id ASC'
            );
            return rows.map((row) => ({
                id: Number(row.id),
                workspace_id: Number(row.workspace_id),
                retention_days: Number(row.retention_days)
            }));
        },
        async rollupDay(siteId, day, from, to) {
            const [views, sessions] = await Promise.all([
                q.query<{ total: number }>(
                    'SELECT COUNT(*) AS total FROM audience_events WHERE site_id = ? AND kind = 0 AND ts >= ? AND ts < ?',
                    [siteId, from, to]
                ),
                q.query<{ total: number; visitors: number }>(
                    `SELECT COUNT(*) AS total, COUNT(DISTINCT visitor_ref) AS visitors
                       FROM audience_sessions WHERE site_id = ? AND started_at >= ? AND started_at < ?`,
                    [siteId, from, to]
                )
            ]);
            await q.execute(
                `INSERT INTO audience_daily (site_id, day, views, sessions, visitors)
                 VALUES (?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE views = VALUES(views), sessions = VALUES(sessions),
                                         visitors = VALUES(visitors)`,
                [
                    siteId,
                    day,
                    Number(views[0]?.total ?? 0),
                    Number(sessions[0]?.total ?? 0),
                    Number(sessions[0]?.visitors ?? 0)
                ]
            );
        },
        async pruneEvents(siteId, before) {
            const res = await q.execute('DELETE FROM audience_events WHERE site_id = ? AND ts < ?', [siteId, before]);
            return res.affectedRows;
        },
        async pruneSessions(siteId, before) {
            const res = await q.execute('DELETE FROM audience_sessions WHERE site_id = ? AND last_at < ?', [
                siteId,
                before
            ]);
            return res.affectedRows;
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
            const res = await q.execute(
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
            return res.affectedRows;
        }
    };
}
