import type {
    NotificationChannelKind,
    NotificationChannelRow,
    NotificationFeature,
    NotificationRouteRow
} from 'deveye-types';

import type { Queryable } from '../pool';

type Q = Queryable;

/**
 * Les canaux d'alerte d'un espace, et les routes qui pointent dessus.
 *
 * Remplace `notificationSettings`, qui portait deux canaux binaires par couple
 * `(espace, feature)`. Trois tables plutôt qu'une : la liaison est un ensemble
 * (plusieurs canaux par route, un canal dans plusieurs routes). Une route est
 * la **sélection** de sa cible — un élément, ou la fonctionnalité elle-même
 * pour un émetteur sans éléments — et il n'y a pas d'héritage (092) : sans
 * route, une cible est silencieuse.
 *
 * Tout ce qui est lisible — libellé, adresse, URL — est **chiffré par
 * l'appelant** avant d'arriver ici : le dépôt ne voit que des cryptogrammes, et
 * ne décide jamais de l'étage.
 */

/** Ce qu'écrit une création ou une modification de canal. */
export interface NotificationChannelWrite {
    kind: NotificationChannelKind;
    /** Libellé chiffré ; `null` = jamais nommé (la reprise de la 087 les laisse ainsi). */
    labelEnc: string | null;
    /** Adresse ou URL chiffrée ; `null` sur un `email` = l'adresse du compte expéditeur. */
    targetEnc: string | null;
    mailAccountId: number | null;
    enabled: boolean;
}

export interface NotificationChannelsRepo {
    /** Les canaux d'une fonctionnalité de l'espace, dans l'ordre d'affichage (091 : chaque émetteur a les siens). */
    list(workspaceId: number, feature: NotificationFeature): Promise<NotificationChannelRow[]>;
    findById(id: number, workspaceId: number): Promise<NotificationChannelRow | null>;
    /** `feature` est la propriétaire du canal, immuable ensuite (l'update ne la touche pas). */
    create(
        workspaceId: number,
        feature: NotificationFeature,
        input: NotificationChannelWrite
    ): Promise<NotificationChannelRow>;
    update(id: number, workspaceId: number, input: NotificationChannelWrite): Promise<NotificationChannelRow | null>;
    /** Les liaisons partent en cascade ; une route laissée vide reste inerte (vide = silence, 092). */
    remove(id: number, workspaceId: number): Promise<boolean>;
    reorder(workspaceId: number, ids: number[]): Promise<void>;

    /**
     * Combien de routes désignent chaque canal — ce que l'écran affiche en
     * « utilisé par N ». Rendu en une requête pour toute la liste : le demander
     * canal par canal mettrait une requête par ligne devant l'ouverture de
     * l'écran.
     */
    usageCounts(workspaceId: number): Promise<Map<number, number>>;

    /** Les cibles que ce canal sert, pour que la confirmation de suppression les nomme. */
    usageDetail(id: number, workspaceId: number): Promise<{ feature: NotificationFeature; itemId: number }[]>;

    /** La route d'une cible, ou `null` quand elle n'a jamais été réglée. */
    findRoute(workspaceId: number, feature: NotificationFeature, itemId: number): Promise<NotificationRouteRow | null>;
    /** Les identifiants de canaux d'une route. */
    routeChannelIds(routeId: number): Promise<number[]>;
    /**
     * Pose la route et ses liaisons. Les canaux inconnus de l'espace sont
     * ignorés silencieusement — la vérification d'appartenance est faite par le
     * handler, et une course entre deux onglets ne doit pas lever.
     */
    setRoute(
        workspaceId: number,
        feature: NotificationFeature,
        itemId: number,
        channelIds: number[]
    ): Promise<NotificationRouteRow>;
    /** Efface la route d'une cible : plus de sélection, elle ne prévient personne. */
    clearRoute(workspaceId: number, feature: NotificationFeature, itemId: number): Promise<void>;
}

export function notificationChannelsRepo(pool: Q): NotificationChannelsRepo {
    async function findById(id: number, workspaceId: number): Promise<NotificationChannelRow | null> {
        const r = await pool.query<NotificationChannelRow>(
            'SELECT * FROM notification_channels WHERE id = ? AND workspace_id = ?',
            [id, workspaceId]
        );
        return r.rows[0] ?? null;
    }

    async function findRoute(
        workspaceId: number,
        feature: NotificationFeature,
        itemId: number
    ): Promise<NotificationRouteRow | null> {
        const r = await pool.query<NotificationRouteRow>(
            'SELECT * FROM notification_routes WHERE workspace_id = ? AND feature = ? AND item_id = ?',
            [workspaceId, feature, itemId]
        );
        return r.rows[0] ?? null;
    }

    return {
        findById,
        findRoute,

        async list(workspaceId, feature) {
            const r = await pool.query<NotificationChannelRow>(
                'SELECT * FROM notification_channels WHERE workspace_id = ? AND feature = ? ORDER BY position, id',
                [workspaceId, feature]
            );
            return r.rows;
        },

        async create(workspaceId, feature, input) {
            // La place suit la dernière : un canal ajouté apparaît en bas, là où
            // on vient de le créer, et non en tête d'une liste qu'on relit.
            const res = await pool.query(
                `INSERT INTO notification_channels
                     (workspace_id, feature, kind, label_enc, target_enc, mail_account_id, enabled, position)
                 VALUES (?, ?, ?, ?, ?, ?, ?,
                     (SELECT COALESCE(MAX(c.position) + 1, 0)
                        FROM (SELECT position FROM notification_channels WHERE workspace_id = ? AND feature = ?) c))`,
                [
                    workspaceId,
                    feature,
                    input.kind,
                    input.labelEnc,
                    input.targetEnc,
                    input.mailAccountId,
                    input.enabled ? 1 : 0,
                    workspaceId,
                    feature
                ]
            );
            const row = await findById(res.insertId, workspaceId);
            if (!row) throw new Error('Canal créé mais introuvable');
            return row;
        },

        async update(id, workspaceId, input) {
            await pool.query(
                `UPDATE notification_channels
                    SET kind = ?, label_enc = ?, target_enc = ?, mail_account_id = ?, enabled = ?
                  WHERE id = ? AND workspace_id = ?`,
                [
                    input.kind,
                    input.labelEnc,
                    input.targetEnc,
                    input.mailAccountId,
                    input.enabled ? 1 : 0,
                    id,
                    workspaceId
                ]
            );
            return findById(id, workspaceId);
        },

        async remove(id, workspaceId) {
            const r = await pool.query('DELETE FROM notification_channels WHERE id = ? AND workspace_id = ?', [
                id,
                workspaceId
            ]);
            return r.rowCount > 0;
        },

        async reorder(workspaceId, ids) {
            // Une requête par ligne, comme les autres réordonnancements du dépôt :
            // les listes sont courtes et le gain d'un CASE massif ne vaut pas sa
            // lisibilité. Le `workspace_id` reste dans le WHERE — un identifiant
            // d'un autre espace glissé dans la liste ne déplace rien.
            for (const [index, id] of ids.entries()) {
                await pool.query('UPDATE notification_channels SET position = ? WHERE id = ? AND workspace_id = ?', [
                    index,
                    id,
                    workspaceId
                ]);
            }
        },

        async usageCounts(workspaceId) {
            const r = await pool.query<{ channel_id: number; n: number }>(
                `SELECT rc.channel_id, COUNT(*) AS n
                   FROM notification_route_channels rc
                   JOIN notification_channels c ON c.id = rc.channel_id
                  WHERE c.workspace_id = ?
                  GROUP BY rc.channel_id`,
                [workspaceId]
            );
            return new Map(r.rows.map((row) => [row.channel_id, Number(row.n)]));
        },

        async usageDetail(id, workspaceId) {
            const r = await pool.query<{ feature: NotificationFeature; item_id: number }>(
                `SELECT r.feature, r.item_id
                   FROM notification_route_channels rc
                   JOIN notification_routes r ON r.id = rc.route_id
                  WHERE rc.channel_id = ? AND r.workspace_id = ?
                  ORDER BY r.feature, r.item_id`,
                [id, workspaceId]
            );
            return r.rows.map((row) => ({ feature: row.feature, itemId: row.item_id }));
        },

        async routeChannelIds(routeId) {
            const r = await pool.query<{ channel_id: number }>(
                `SELECT rc.channel_id
                   FROM notification_route_channels rc
                   JOIN notification_channels c ON c.id = rc.channel_id
                  WHERE rc.route_id = ?
                  ORDER BY c.position, c.id`,
                [routeId]
            );
            return r.rows.map((row) => row.channel_id);
        },

        async setRoute(workspaceId, feature, itemId, channelIds) {
            await pool.query(
                `INSERT INTO notification_routes (workspace_id, feature, item_id) VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
                [workspaceId, feature, itemId]
            );
            const route = await findRoute(workspaceId, feature, itemId);
            if (!route) throw new Error('Route écrite mais introuvable');

            // Effacer puis réécrire : l'ensemble des canaux d'une route est une
            // valeur, pas une collection à réconcilier. Un différentiel coûterait
            // deux lectures et deux écritures pour le même résultat.
            //
            // `c.feature = ?` : une route ne peut désigner que des canaux de SA
            // fonctionnalité (091) — un identifiant d'un autre émetteur glissé
            // dans la liste est ignoré comme le serait celui d'un autre espace.
            await pool.query('DELETE FROM notification_route_channels WHERE route_id = ?', [route.id]);
            for (const channelId of channelIds) {
                await pool.query(
                    `INSERT IGNORE INTO notification_route_channels (route_id, channel_id)
                     SELECT ?, c.id FROM notification_channels c
                      WHERE c.id = ? AND c.workspace_id = ? AND c.feature = ?`,
                    [route.id, channelId, workspaceId, feature]
                );
            }
            return route;
        },

        async clearRoute(workspaceId, feature, itemId) {
            await pool.query('DELETE FROM notification_routes WHERE workspace_id = ? AND feature = ? AND item_id = ?', [
                workspaceId,
                feature,
                itemId
            ]);
        }
    };
}
