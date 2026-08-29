import type { ProjectMessageRow } from '../../contracts/domain';
import type { SdkQueryable } from '@deveye/types/sdk/server';

/** Les tables `project_messages` et `project_card_reads` : le fil d'une carte. */
export interface ProjectChatRepo {
    /**
     * Une page du fil, du plus récent au plus ancien, l'ordre où l'on pagine : à
     * l'appelant de la retourner pour l'affichage. `before` exclu.
     */
    listByCard(cardId: number, workspaceId: number, before: number | null, limit: number): Promise<ProjectMessageRow[]>;
    /**
     * Par identifiant seul : l'espace du message est celui de son projet, que
     * l'appelant vérifie avant d'agir. Les écritures prennent le domicile du projet.
     */
    findById(messageId: number): Promise<ProjectMessageRow | null>;
    create(input: {
        cardId: number;
        projectId: number;
        workspaceId: number;
        authorUserId: number;
        mentions: number[];
        content: string;
    }): Promise<ProjectMessageRow>;
    update(
        messageId: number,
        workspaceId: number,
        input: { mentions: number[]; content: string }
    ): Promise<ProjectMessageRow | null>;
    /** Pose le point d'eau haute de lecture d'un membre sur une carte. */
    markRead(cardId: number, workspaceId: number, userId: number, lastMessageId: number): Promise<void>;
}

export function projectChatRepo(q: SdkQueryable): ProjectChatRepo {
    return {
        async listByCard(cardId, workspaceId, before, limit) {
            return q.query<ProjectMessageRow>(
                `SELECT * FROM project_messages
                 WHERE card_id = ? AND workspace_id = ?${before === null ? '' : ' AND id < ?'}
                 ORDER BY id DESC
                 LIMIT ?`,
                before === null ? [cardId, workspaceId, limit] : [cardId, workspaceId, before, limit]
            );
        },
        async findById(messageId) {
            const rows = await q.query<ProjectMessageRow>('SELECT * FROM project_messages WHERE id = ?', [messageId]);
            return rows[0] ?? null;
        },
        async create({ cardId, projectId, workspaceId, authorUserId, mentions, content }) {
            const res = await q.execute(
                `INSERT INTO project_messages (card_id, project_id, workspace_id, author_user_id, mentions, content)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [
                    cardId,
                    projectId,
                    workspaceId,
                    authorUserId,
                    mentions.length ? JSON.stringify(mentions) : null,
                    content
                ]
            );
            // Compteur dénormalisé : le badge « des messages ici » se calcule sans
            // parcourir le fil ni rien déchiffrer.
            await q.execute(
                `UPDATE project_cards SET message_count = message_count + 1, last_message_at = UNIX_TIMESTAMP()
                 WHERE id = ? AND workspace_id = ?`,
                [cardId, workspaceId]
            );
            const rows = await q.query<ProjectMessageRow>('SELECT * FROM project_messages WHERE id = ?', [
                res.insertId
            ]);
            return rows[0];
        },
        async update(messageId, workspaceId, { mentions, content }) {
            const res = await q.execute(
                `UPDATE project_messages SET content = ?, mentions = ?, edited = UNIX_TIMESTAMP()
                 WHERE id = ? AND workspace_id = ?`,
                [content, mentions.length ? JSON.stringify(mentions) : null, messageId, workspaceId]
            );
            if (res.affectedRows === 0) return null;
            return this.findById(messageId);
        },
        async markRead(cardId, workspaceId, userId, lastMessageId) {
            // `GREATEST` : la marque ne recule jamais, deux onglets qui lisent en
            // désordre ne doivent pas faire réapparaître des non-lus.
            await q.execute(
                `INSERT INTO project_card_reads (card_id, user_id, workspace_id, last_read_message_id, read_at)
                 VALUES (?, ?, ?, ?, UNIX_TIMESTAMP())
                 ON DUPLICATE KEY UPDATE
                     last_read_message_id = GREATEST(last_read_message_id, VALUES(last_read_message_id)),
                     read_at = UNIX_TIMESTAMP()`,
                [cardId, userId, workspaceId, lastMessageId]
            );
        }
    };
}
