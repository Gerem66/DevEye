import type { SdkQueryable } from '@deveye/types/sdk/server';

import type { BoardAppearance } from '../contracts/domain';

/** Une ligne de liste : tout sauf la scène et l'aperçu, qui pèsent. */
export interface BoardRow {
    id: number;
    workspace_id: number;
    user_id: number | null;
    updated_by: number | null;
    content: string;
    scene_bytes: number;
    version: number;
    preview_bytes: number;
    preview_version: number;
    has_preview: number;
    files_bytes: number;
    background: string | null;
    theme: string | null;
    created: number;
    updated: number;
}

export interface SceneRow {
    id: number;
    workspace_id: number;
    scene: string;
    version: number;
}

export interface FileRow {
    id: number;
    board_id: number;
    file_id: string;
    mime: string;
    bytes: number;
    object_key: string;
    created: number;
    orphaned_at: number | null;
}

const OF_BOARD = `b.id, b.workspace_id, b.user_id, b.updated_by, b.content, b.scene_bytes, b.version,
    b.preview_bytes, b.preview_version, (b.preview IS NOT NULL) AS has_preview,
    (SELECT COALESCE(SUM(f.bytes), 0) FROM ft_whiteboard_files f WHERE f.board_id = b.id) AS files_bytes,
    b.background, b.theme, b.created, b.updated`;

const FILE_COLUMNS = 'id, board_id, file_id, mime, bytes, object_key, created, orphaned_at';

/** Le tableau est chez lui dans l'espace, ou projeté dedans. */
const VISIBLE_IN = `(b.workspace_id = ?
    OR EXISTS (SELECT 1 FROM item_shares sh
                WHERE sh.feature = 'whiteboard' AND sh.item_id = b.id
                  AND sh.home_workspace_id = b.workspace_id AND sh.workspace_id = ?))`;

export interface WhiteboardRepo {
    boards: {
        /** Ceux de l'espace et ceux qu'un autre espace y projette, les derniers modifiés d'abord. */
        listVisible(workspaceId: number): Promise<BoardRow[]>;
        countVisible(workspaceId: number): Promise<number>;
        findVisible(id: number, workspaceId: number): Promise<BoardRow | null>;
        /** Où qu'il soit : pour la séance et le service, jamais pour un membre. */
        findById(id: number): Promise<BoardRow | null>;
        /** Scène, aperçu et images de tous ces espaces : le compteur du quota. */
        storedBytesIn(workspaceIds: readonly number[]): Promise<number>;
        create(input: {
            workspaceId: number;
            userId: number;
            content: string;
            scene: string;
            sceneBytes: number;
            appearance: BoardAppearance;
            at: number;
        }): Promise<number>;
        rename(id: number, workspaceId: number, content: string, userId: number, at: number): Promise<boolean>;
        loadScene(id: number): Promise<SceneRow | null>;
        /** Compare-and-set sur `version` : `false` quand le tableau a bougé entre-temps. */
        saveScene(input: {
            id: number;
            workspaceId: number;
            baseVersion: number;
            scene: string;
            sceneBytes: number;
            userId: number | null;
            at: number;
        }): Promise<boolean>;
        /** Un champ absent garde sa valeur. */
        setAppearance(
            id: number,
            workspaceId: number,
            appearance: Partial<BoardAppearance>,
            userId: number,
            at: number
        ): Promise<boolean>;
        setPreview(id: number, workspaceId: number, preview: string, bytes: number): Promise<boolean>;
        previews(ids: readonly number[]): Promise<{ id: number; workspace_id: number; preview: string }[]>;
        remove(id: number, workspaceId: number): Promise<boolean>;
    };
    files: {
        listOf(boardId: number): Promise<FileRow[]>;
        find(boardId: number, fileId: string): Promise<FileRow | null>;
        findMany(boardId: number, fileIds: readonly string[]): Promise<FileRow[]>;
        insert(input: {
            boardId: number;
            fileId: string;
            mime: string;
            bytes: number;
            objectKey: string;
            at: number;
        }): Promise<number>;
        deleteRow(id: number): Promise<void>;
        /** Pose `orphaned_at` sur ce qu'aucun élément ne référence, le lève sur le reste. */
        reconcileOrphans(boardId: number, referenced: readonly string[], at: number): Promise<void>;
        orphanedBefore(at: number, limit: number): Promise<FileRow[]>;
        objectKeysOf(boardId: number): Promise<string[]>;
        /** Toutes les clés connues, pour le balayage des objets sans ligne. */
        allObjectKeys(): Promise<string[]>;
        /** Tous espaces confondus, pour la vue d'ensemble de l'administration. */
        totals(): Promise<{ boards: number; imageBytes: number }>;
    };
    key: {
        sealed(): Promise<string | null>;
        insertSealed(sealed: string): Promise<void>;
    };
}

/** La première ligne d'une lecture : la requête reste écrite en entier à l'appel, que `check:queries` la prépare. */
async function first<T>(rows: Promise<T[]>): Promise<T | null> {
    return (await rows)[0] ?? null;
}

export function createRepo(q: SdkQueryable): WhiteboardRepo {
    return {
        boards: {
            listVisible(workspaceId) {
                return q.query<BoardRow>(
                    `SELECT ${OF_BOARD} FROM ft_whiteboard_boards b WHERE ${VISIBLE_IN}
                      ORDER BY b.updated DESC, b.id DESC`,
                    [workspaceId, workspaceId]
                );
            },
            async countVisible(workspaceId) {
                const row = await first(
                    q.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ft_whiteboard_boards b WHERE ${VISIBLE_IN}`, [
                        workspaceId,
                        workspaceId
                    ])
                );
                return Number(row?.n ?? 0);
            },
            findVisible(id, workspaceId) {
                return first(
                    q.query<BoardRow>(
                        `SELECT ${OF_BOARD} FROM ft_whiteboard_boards b WHERE b.id = ? AND ${VISIBLE_IN}`,
                        [id, workspaceId, workspaceId]
                    )
                );
            },
            findById(id) {
                return first(q.query<BoardRow>(`SELECT ${OF_BOARD} FROM ft_whiteboard_boards b WHERE b.id = ?`, [id]));
            },
            async storedBytesIn(workspaceIds) {
                if (workspaceIds.length === 0) return 0;
                const row = await first(
                    q.query<{ n: number | null }>(
                        `SELECT (SELECT COALESCE(SUM(b.scene_bytes + b.preview_bytes), 0)
                                   FROM ft_whiteboard_boards b WHERE b.workspace_id IN (?))
                              + (SELECT COALESCE(SUM(f.bytes), 0)
                                   FROM ft_whiteboard_files f JOIN ft_whiteboard_boards b ON b.id = f.board_id
                                  WHERE b.workspace_id IN (?)) AS n`,
                        [[...workspaceIds], [...workspaceIds]]
                    )
                );
                return Number(row?.n ?? 0);
            },
            async create(input) {
                const res = await q.execute(
                    `INSERT INTO ft_whiteboard_boards
                        (workspace_id, user_id, updated_by, content, scene, scene_bytes, version, background, theme,
                         created, updated)
                     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
                    [
                        input.workspaceId,
                        input.userId,
                        input.userId,
                        input.content,
                        input.scene,
                        input.sceneBytes,
                        input.appearance.background,
                        input.appearance.theme,
                        input.at,
                        input.at
                    ]
                );
                return res.insertId;
            },
            async rename(id, workspaceId, content, userId, at) {
                const res = await q.execute(
                    'UPDATE ft_whiteboard_boards SET content = ?, updated_by = ?, updated = ? WHERE id = ? AND workspace_id = ?',
                    [content, userId, at, id, workspaceId]
                );
                return res.affectedRows === 1;
            },
            loadScene(id) {
                return first(
                    q.query<SceneRow>(
                        'SELECT id, workspace_id, scene, version FROM ft_whiteboard_boards WHERE id = ?',
                        [id]
                    )
                );
            },
            async saveScene(input) {
                const res = await q.execute(
                    `UPDATE ft_whiteboard_boards
                        SET scene = ?, scene_bytes = ?, version = version + 1, updated_by = ?, updated = ?
                      WHERE id = ? AND workspace_id = ? AND version = ?`,
                    [
                        input.scene,
                        input.sceneBytes,
                        input.userId,
                        input.at,
                        input.id,
                        input.workspaceId,
                        input.baseVersion
                    ]
                );
                return res.affectedRows === 1;
            },
            async setAppearance(id, workspaceId, appearance, userId, at) {
                const res = await q.execute(
                    `UPDATE ft_whiteboard_boards
                        SET background = IF(?, ?, background), theme = IF(?, ?, theme), updated_by = ?, updated = ?
                      WHERE id = ? AND workspace_id = ?`,
                    [
                        appearance.background !== undefined,
                        appearance.background ?? null,
                        appearance.theme !== undefined,
                        appearance.theme ?? null,
                        userId,
                        at,
                        id,
                        workspaceId
                    ]
                );
                return res.affectedRows === 1;
            },
            async setPreview(id, workspaceId, preview, bytes) {
                const res = await q.execute(
                    `UPDATE ft_whiteboard_boards
                        SET preview = ?, preview_bytes = ?, preview_version = preview_version + 1
                      WHERE id = ? AND workspace_id = ?`,
                    [preview, bytes, id, workspaceId]
                );
                return res.affectedRows === 1;
            },
            previews(ids) {
                if (ids.length === 0) return Promise.resolve([]);
                return q.query<{ id: number; workspace_id: number; preview: string }>(
                    'SELECT id, workspace_id, preview FROM ft_whiteboard_boards WHERE id IN (?) AND preview IS NOT NULL',
                    [[...ids]]
                );
            },
            async remove(id, workspaceId) {
                const res = await q.execute('DELETE FROM ft_whiteboard_boards WHERE id = ? AND workspace_id = ?', [
                    id,
                    workspaceId
                ]);
                return res.affectedRows === 1;
            }
        },
        files: {
            listOf(boardId) {
                return q.query<FileRow>(
                    `SELECT ${FILE_COLUMNS} FROM ft_whiteboard_files WHERE board_id = ? ORDER BY id`,
                    [boardId]
                );
            },
            find(boardId, fileId) {
                return first(
                    q.query<FileRow>(
                        `SELECT ${FILE_COLUMNS} FROM ft_whiteboard_files WHERE board_id = ? AND file_id = ?`,
                        [boardId, fileId]
                    )
                );
            },
            findMany(boardId, fileIds) {
                if (fileIds.length === 0) return Promise.resolve([]);
                return q.query<FileRow>(
                    `SELECT ${FILE_COLUMNS} FROM ft_whiteboard_files WHERE board_id = ? AND file_id IN (?)`,
                    [boardId, [...fileIds]]
                );
            },
            async insert(input) {
                const res = await q.execute(
                    `INSERT INTO ft_whiteboard_files (board_id, file_id, mime, bytes, object_key, created)
                     VALUES (?, ?, ?, ?, ?, ?)`,
                    [input.boardId, input.fileId, input.mime, input.bytes, input.objectKey, input.at]
                );
                return res.insertId;
            },
            async deleteRow(id) {
                await q.execute('DELETE FROM ft_whiteboard_files WHERE id = ?', [id]);
            },
            async reconcileOrphans(boardId, referenced, at) {
                if (referenced.length === 0) {
                    await q.execute(
                        'UPDATE ft_whiteboard_files SET orphaned_at = ? WHERE board_id = ? AND orphaned_at IS NULL',
                        [at, boardId]
                    );
                    return;
                }
                await q.execute(
                    `UPDATE ft_whiteboard_files SET orphaned_at = ?
                      WHERE board_id = ? AND orphaned_at IS NULL AND file_id NOT IN (?)`,
                    [at, boardId, [...referenced]]
                );
                await q.execute(
                    `UPDATE ft_whiteboard_files SET orphaned_at = NULL
                      WHERE board_id = ? AND orphaned_at IS NOT NULL AND file_id IN (?)`,
                    [boardId, [...referenced]]
                );
            },
            orphanedBefore(at, limit) {
                return q.query<FileRow>(
                    `SELECT ${FILE_COLUMNS} FROM ft_whiteboard_files
                      WHERE orphaned_at IS NOT NULL AND orphaned_at < ? ORDER BY id LIMIT ?`,
                    [at, limit]
                );
            },
            async objectKeysOf(boardId) {
                const rows = await q.query<{ object_key: string }>(
                    'SELECT object_key FROM ft_whiteboard_files WHERE board_id = ?',
                    [boardId]
                );
                return rows.map((r) => r.object_key);
            },
            async allObjectKeys() {
                const rows = await q.query<{ object_key: string }>('SELECT object_key FROM ft_whiteboard_files', []);
                return rows.map((r) => r.object_key);
            },
            async totals() {
                const row = await first(
                    q.query<{ boards: number; image_bytes: number | null }>(
                        `SELECT (SELECT COUNT(*) FROM ft_whiteboard_boards) AS boards,
                                (SELECT SUM(bytes) FROM ft_whiteboard_files) AS image_bytes`,
                        []
                    )
                );
                return { boards: Number(row?.boards ?? 0), imageBytes: Number(row?.image_bytes ?? 0) };
            }
        },
        key: {
            async sealed() {
                const row = await first(
                    q.query<{ sealed: string }>('SELECT sealed FROM ft_whiteboard_key WHERE id = 1', [])
                );
                return row?.sealed ?? null;
            },
            async insertSealed(sealed) {
                await q.execute('INSERT IGNORE INTO ft_whiteboard_key (id, sealed) VALUES (1, ?)', [sealed]);
            }
        }
    };
}
