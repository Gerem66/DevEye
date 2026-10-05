import type {
    MailAccountRow,
    MailAccountStatus,
    MailAuthMethod,
    MailBodyRenderMode,
    MailFolderRow,
    MailFolderSpecialUse,
    MailMessageCursor,
    MailMessageRow,
    MailSecurityTier,
    MailSettingsRow
} from '../contracts/domain';
import type { SdkQueryable, SdkStockItem } from '@deveye/types/sdk/server';

/**
 * Le dépôt du module sur `SdkQueryable`, en sections parce que les mêmes verbes
 * se répètent d'une table à l'autre (`findById`, `reorder`, `delete`).
 * L'allowlist de `deveye-feature.json` dispense les tables `mail_*` du préfixe
 * `ft_mail_`.
 */
export interface MailRepo {
    accounts: MailAccountsRepo;
    folders: MailFoldersRepo;
    messages: MailMessagesRepo;
    settings: MailSettingsRepo;
}

/** The user-settable part of an account (everything but its live sync state). */
export interface MailAccountConfig {
    /** Encrypted per `securityTier`. */
    displayNameEnc: string;
    /** Encrypted per `securityTier`. */
    emailAddressEnc: string;
    securityTier: MailSecurityTier;
    authMethod: MailAuthMethod;
    /** Encrypted per `securityTier` — the only place secrets live. */
    credentialsEnc: string;
    enabled: boolean;
    /** Background-sync cadence for this mailbox alone (seconds). */
    syncIntervalSeconds: number;
}

export interface MailAccountsRepo {
    listByWorkspace(workspaceId: number): Promise<MailAccountRow[]>;
    countInWorkspaces(workspaceIds: readonly number[]): Promise<number>;
    /** Toute l'instance : les boîtes reliées par OAuth, et les comptes qui les ont reliées, par fournisseur. */
    countOAuth(): Promise<{ authMethod: MailAuthMethod; boxes: number; users: number }[]>;
    /** Ce que compte `countInWorkspaces`, du plus ancien au plus récent : le stock du quota `accounts`. */
    listStock(workspaceIds: readonly number[]): Promise<SdkStockItem[]>;
    /**
     * Les comptes visibles depuis cet espace : les siens, plus ceux qu'un autre
     * espace y projette (`item_shares`), les locaux d'abord. Ne retient des
     * projetés que les comptes ouverts : un compte gardé est chiffré par le mot
     * de passe de son auteur, illisible ailleurs. La relève de fond passe par
     * `listByWorkspace` : la relancer une fois par espace qui voit la boîte
     * doublerait les requêtes IMAP.
     */
    listVisible(workspaceId: number): Promise<MailAccountRow[]>;
    findById(id: number, workspaceId: number): Promise<MailAccountRow | null>;
    /** Comme `findById`, mais accepte aussi un compte ouvert projeté vers cet espace. */
    findVisible(id: number, workspaceId: number): Promise<MailAccountRow | null>;
    /** Unscoped read for the background sync loop, which has no live user session. */
    findByIdUnscoped(id: number): Promise<MailAccountRow | null>;
    create(input: { userId: number; workspaceId: number } & MailAccountConfig): Promise<MailAccountRow>;
    update(id: number, workspaceId: number, input: MailAccountConfig): Promise<MailAccountRow | null>;
    setEnabled(id: number, workspaceId: number, enabled: boolean): Promise<MailAccountRow | null>;
    setAllowRemoteImages(id: number, workspaceId: number, allowed: boolean): Promise<MailAccountRow | null>;
    delete(id: number, workspaceId: number): Promise<boolean>;
    reorder(workspaceId: number, ids: number[]): Promise<void>;
    /** Write back a sync outcome, `last_sync_at` compris : c'est ce qui remet le compte dans la rotation. */
    recordSync(
        id: number,
        lastSyncAt: number,
        lastSyncErrorEnc: string | null,
        status: MailAccountStatus
    ): Promise<void>;
    /**
     * Même écriture d'état, mais sans toucher `last_sync_at` : l'issue d'une
     * commande dit ce que vaut l'accès à la boîte, pas quand elle a été relevée,
     * et les confondre repousserait d'autant le prochain passage de fond.
     */
    recordStatus(id: number, at: number, lastSyncErrorEnc: string | null, status: MailAccountStatus): Promise<void>;
    /** Persist a refreshed OAuth token blob without touching anything else. */
    updateCredentials(id: number, credentialsEnc: string): Promise<void>;
    /** Re-key the cached error alone, when a tier switch changes which cipher it must be under. */
    updateSyncError(id: number, lastSyncErrorEnc: string | null): Promise<void>;
    /**
     * Les comptes actifs et ouverts dus pour la relève de fond (jamais les
     * gardés, relevés à la demande pendant une session), l'échéance tenant à la
     * cadence propre de chacun. `pausedIds`, que l'offre tient en pause, sont
     * écartés dans la requête : filtrés après le `LIMIT`, ils rempliraient la
     * fenêtre sans que leur `last_sync_at` n'avance jamais.
     */
    listSyncDue(now: number, limit: number, pausedIds: readonly number[]): Promise<MailAccountRow[]>;
}

export interface MailFolderUpsertInput {
    accountId: number;
    imapPath: string;
    /** Encrypted per the account's tier. */
    nameEnc: string;
    specialUse: MailFolderSpecialUse;
    uidValidity: number | null;
}

export interface MailFoldersRepo {
    listByAccount(accountId: number): Promise<MailFolderRow[]>;
    findById(id: number): Promise<MailFolderRow | null>;
    findByImapPath(accountId: number, imapPath: string): Promise<MailFolderRow | null>;
    /** Create or update-in-place by `(accountId, imapPath)` — new folders land at the end of the list. */
    upsert(input: MailFolderUpsertInput): Promise<MailFolderRow>;
    updateCounts(
        id: number,
        input: {
            uidValidity: number | null;
            lastSeenUid: number | null;
            firstSeenUid: number | null;
            unreadCount: number;
            totalCount: number;
        }
    ): Promise<void>;
    reorder(accountId: number, ids: number[]): Promise<void>;
    /** Re-key a folder's encrypted name, for a tier switch. */
    updateNameEnc(id: number, nameEnc: string): Promise<void>;
}

export interface MailMessageEnvelopeInput {
    folderId: number;
    uid: number;
    /** Encrypted per the account's tier: `{ subject, from, to, snippet }`. */
    envelopeEnc: string;
    date: number;
    seen: boolean;
    flagged: boolean;
    answered: boolean;
    hasAttachments: boolean;
}

/** Les drapeaux tels qu'ils sont en cache : de quoi décider quoi réécrire sans toucher à l'enveloppe. */
export interface MailMessageFlagsRow {
    id: number;
    uid: number;
    seen: number;
    flagged: number;
    answered: number;
}

export interface MailMessagesRepo {
    /** Counts from the cache, used to keep `mail_folders.unread_count/total_count` in step after a sync. */
    countByFolder(folderId: number): Promise<{ total: number; unseen: number }>;
    /** Lowest cached UID, or null if empty; backstops `mail_folders.first_seen_uid`. */
    minUidByFolder(folderId: number): Promise<number | null>;
    /**
     * Newest **by date** first, paged on `(date, id)`. Not by row id: ids are
     * insertion order and the cache is not filled in date order, backfill and
     * remote search writing older messages in after newer ones. `id` only breaks
     * ties between equal dates, which keeps the page boundary exact.
     */
    listByFolder(folderId: number, cursor: MailMessageCursor | null, limit: number): Promise<MailMessageRow[]>;
    findById(id: number): Promise<MailMessageRow | null>;
    /** Every cached row of a folder, unpaged — only for a tier switch's re-key pass. */
    listAllByFolder(folderId: number): Promise<MailMessageRow[]>;
    /**
     * Newest-first scan surface for `mail.messageSearch`, capped by `limit`. Not
     * a page of results but the rows the handler will decrypt to look inside:
     * the envelopes are encrypted, so the filtering cannot happen in SQL.
     */
    listForSearch(folderId: number, limit: number): Promise<MailMessageRow[]>;
    /** Cached rows for specific UIDs — how a remote search finds which of its hits it already holds. */
    listByFolderUids(folderId: number, uids: number[]): Promise<MailMessageRow[]>;
    /**
     * Les `limit` UID les plus hauts du cache d'un dossier, avec leurs drapeaux :
     * la fenêtre que la synchro va redemander au serveur pour la réconcilier.
     * Trié par UID et non par date, parce que c'est en UID que se formule la
     * plage IMAP à relire.
     */
    listFlagsWindow(folderId: number, limit: number): Promise<MailMessageFlagsRow[]>;
    /** Re-key one cached envelope, for a tier switch. */
    updateEnvelopeEnc(id: number, envelopeEnc: string): Promise<void>;
    /** Create or refresh the cached envelope for `(folderId, uid)`. */
    upsertEnvelope(input: MailMessageEnvelopeInput): Promise<MailMessageRow>;
    setFlags(
        id: number,
        flags: Partial<{ seen: boolean; flagged: boolean; answered: boolean }>
    ): Promise<MailMessageRow | null>;
    /**
     * Écrit les trois drapeaux d'un coup, sans relire la ligne, contrairement à
     * {@link setFlags} : la réconciliation connaît déjà l'état qu'elle pose et
     * tourne sur chaque dossier à chaque tick.
     */
    updateFlags(id: number, flags: { seen: boolean; flagged: boolean; answered: boolean }): Promise<void>;
    moveFolder(id: number, toFolderId: number, newUid: number): Promise<void>;
    delete(id: number): Promise<boolean>;
    /** Drops every cached message of a folder — used when UIDVALIDITY changes. */
    deleteByFolder(folderId: number): Promise<void>;
    /** Supprime les lignes dont l'UID a disparu côté serveur. Rend le nombre effacé. */
    deleteByFolderUids(folderId: number, uids: number[]): Promise<number>;
}

export interface MailSettingsRepo {
    get(workspaceId: number): Promise<MailSettingsRow | null>;
    set(
        workspaceId: number,
        input: {
            externalScanEnabledDefault: boolean;
            trustedImageDomains: string[];
            bodyRenderMode: MailBodyRenderMode;
        }
    ): Promise<MailSettingsRow>;
}

function accountConfigParams(c: MailAccountConfig): unknown[] {
    return [
        c.displayNameEnc,
        c.emailAddressEnc,
        c.securityTier,
        c.authMethod,
        c.credentialsEnc,
        c.enabled ? 1 : 0,
        c.syncIntervalSeconds
    ];
}

function accountsRepo(q: SdkQueryable): MailAccountsRepo {
    async function reload(id: number, workspaceId: number): Promise<MailAccountRow | null> {
        const rows = await q.query<MailAccountRow>('SELECT * FROM mail_accounts WHERE id = ? AND workspace_id = ?', [
            id,
            workspaceId
        ]);
        return rows[0] ?? null;
    }

    return {
        async countInWorkspaces(workspaceIds) {
            if (workspaceIds.length === 0) return 0;
            const rows = await q.query<{ total: number }>(
                'SELECT COUNT(*) AS total FROM mail_accounts WHERE workspace_id IN (?)',
                [[...workspaceIds]]
            );
            return Number(rows[0]?.total ?? 0);
        },
        async countOAuth() {
            const rows = await q.query<{ auth_method: MailAuthMethod; boxes: number; users: number }>(
                `SELECT auth_method, COUNT(*) AS boxes, COUNT(DISTINCT user_id) AS users
                 FROM mail_accounts WHERE auth_method <> 'password' GROUP BY auth_method`
            );
            return rows.map((row) => ({
                authMethod: row.auth_method,
                boxes: Number(row.boxes),
                users: Number(row.users)
            }));
        },
        async listStock(workspaceIds) {
            if (workspaceIds.length === 0) return [];
            const rows = await q.query<{ id: number; workspace_id: number }>(
                'SELECT id, workspace_id FROM mail_accounts WHERE workspace_id IN (?) ORDER BY created ASC, id ASC',
                [[...workspaceIds]]
            );
            return rows.map((row) => ({ id: String(row.id), workspaceId: Number(row.workspace_id) }));
        },
        async listByWorkspace(workspaceId) {
            return q.query<MailAccountRow>(
                'SELECT * FROM mail_accounts WHERE workspace_id = ? ORDER BY sort_order ASC, id ASC',
                [workspaceId]
            );
        },
        async listVisible(workspaceId) {
            // `sort_order` appartient à l'espace d'origine : un compte projeté
            // se range après les locaux, par identifiant.
            return q.query<MailAccountRow>(
                `SELECT v.* FROM (
                     SELECT a.* FROM mail_accounts a WHERE a.workspace_id = ?
                     UNION
                     SELECT a.* FROM mail_accounts a
                       JOIN item_shares sh
                         ON sh.feature = 'mail' AND sh.item_id = a.id AND sh.home_workspace_id = a.workspace_id
                      WHERE sh.workspace_id = ? AND a.security_tier = 'open'
                 ) v
                 ORDER BY v.workspace_id <> ?, v.sort_order ASC, v.id ASC`,
                [workspaceId, workspaceId, workspaceId]
            );
        },
        findById: reload,
        async findVisible(id, workspaceId) {
            const rows = await q.query<MailAccountRow>(
                `SELECT a.* FROM mail_accounts a
                  WHERE a.id = ?
                    AND (a.workspace_id = ?
                         OR (a.security_tier = 'open'
                             AND EXISTS (SELECT 1 FROM item_shares sh
                                          WHERE sh.feature = 'mail' AND sh.item_id = a.id
                                            AND sh.home_workspace_id = a.workspace_id
                                            AND sh.workspace_id = ?)))`,
                [id, workspaceId, workspaceId]
            );
            return rows[0] ?? null;
        },
        async findByIdUnscoped(id) {
            const rows = await q.query<MailAccountRow>('SELECT * FROM mail_accounts WHERE id = ?', [id]);
            return rows[0] ?? null;
        },
        async create({ userId, workspaceId, ...config }) {
            // New accounts land at the end of the list, never in the middle.
            const posRows = await q.query<{ next: number }>(
                'SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM mail_accounts WHERE workspace_id = ?',
                [workspaceId]
            );
            const res = await q.execute(
                `INSERT INTO mail_accounts
                     (user_id, workspace_id, display_name_enc, email_address_enc, security_tier, auth_method,
                      credentials_enc, enabled, sync_interval_seconds, sort_order)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [userId, workspaceId, ...accountConfigParams(config), Number(posRows[0]?.next ?? 0)]
            );
            const rows = await q.query<MailAccountRow>('SELECT * FROM mail_accounts WHERE id = ?', [res.insertId]);
            return rows[0];
        },
        async update(id, workspaceId, config) {
            const res = await q.execute(
                `UPDATE mail_accounts
                 SET display_name_enc = ?, email_address_enc = ?, security_tier = ?, auth_method = ?,
                     credentials_enc = ?, enabled = ?, sync_interval_seconds = ?
                 WHERE id = ? AND workspace_id = ?`,
                [...accountConfigParams(config), id, workspaceId]
            );
            if (res.affectedRows === 0) return null;
            return reload(id, workspaceId);
        },
        async setEnabled(id, workspaceId, enabled) {
            const res = await q.execute('UPDATE mail_accounts SET enabled = ? WHERE id = ? AND workspace_id = ?', [
                enabled ? 1 : 0,
                id,
                workspaceId
            ]);
            if (res.affectedRows === 0) return null;
            return reload(id, workspaceId);
        },
        async setAllowRemoteImages(id, workspaceId, allowed) {
            const res = await q.execute(
                'UPDATE mail_accounts SET allow_remote_images = ? WHERE id = ? AND workspace_id = ?',
                [allowed ? 1 : 0, id, workspaceId]
            );
            if (res.affectedRows === 0) return null;
            return reload(id, workspaceId);
        },
        async delete(id, workspaceId) {
            const res = await q.execute('DELETE FROM mail_accounts WHERE id = ? AND workspace_id = ?', [
                id,
                workspaceId
            ]);
            return res.affectedRows > 0;
        },
        async reorder(workspaceId, ids) {
            for (let i = 0; i < ids.length; i++) {
                await q.execute('UPDATE mail_accounts SET sort_order = ? WHERE id = ? AND workspace_id = ?', [
                    i,
                    ids[i],
                    workspaceId
                ]);
            }
        },
        async recordSync(id, lastSyncAt, lastSyncErrorEnc, status) {
            await q.execute(
                `UPDATE mail_accounts
                 SET last_sync_at = ?, last_sync_error_enc = ?, last_sync_status = ?,
                     last_error_at = IF(? = 'ok', NULL, COALESCE(last_error_at, ?))
                 WHERE id = ?`,
                [lastSyncAt, lastSyncErrorEnc, status, status, lastSyncAt, id]
            );
        },
        async recordStatus(id, at, lastSyncErrorEnc, status) {
            await q.execute(
                `UPDATE mail_accounts
                 SET last_sync_error_enc = ?, last_sync_status = ?,
                     last_error_at = IF(? = 'ok', NULL, COALESCE(last_error_at, ?))
                 WHERE id = ?`,
                [lastSyncErrorEnc, status, status, at, id]
            );
        },
        async updateCredentials(id, credentialsEnc) {
            await q.execute('UPDATE mail_accounts SET credentials_enc = ? WHERE id = ?', [credentialsEnc, id]);
        },
        async updateSyncError(id, lastSyncErrorEnc) {
            await q.execute('UPDATE mail_accounts SET last_sync_error_enc = ? WHERE id = ?', [lastSyncErrorEnc, id]);
        },
        async listSyncDue(now, limit, pausedIds) {
            // `NOT IN ()` n'est pas du SQL : la clause n'existe qu'avec des pauses.
            const paused = pausedIds.length > 0;
            return q.query<MailAccountRow>(
                `SELECT * FROM mail_accounts
                 WHERE enabled = 1 AND security_tier = 'open'
                   AND (last_sync_at IS NULL OR last_sync_at <= ? - sync_interval_seconds)
                   ${paused ? 'AND id NOT IN (?)' : ''}
                 ORDER BY last_sync_at IS NOT NULL, last_sync_at ASC
                 LIMIT ?`,
                paused ? [now, [...pausedIds], limit] : [now, limit]
            );
        }
    };
}

function foldersRepo(q: SdkQueryable): MailFoldersRepo {
    return {
        async listByAccount(accountId) {
            return q.query<MailFolderRow>(
                'SELECT * FROM mail_folders WHERE account_id = ? ORDER BY sort_order ASC, id ASC',
                [accountId]
            );
        },
        async findById(id) {
            const rows = await q.query<MailFolderRow>('SELECT * FROM mail_folders WHERE id = ?', [id]);
            return rows[0] ?? null;
        },
        async findByImapPath(accountId, imapPath) {
            const rows = await q.query<MailFolderRow>(
                'SELECT * FROM mail_folders WHERE account_id = ? AND imap_path = ?',
                [accountId, imapPath]
            );
            return rows[0] ?? null;
        },
        async upsert({ accountId, imapPath, nameEnc, specialUse, uidValidity }) {
            const existing = await this.findByImapPath(accountId, imapPath);
            if (existing) {
                await q.execute(
                    'UPDATE mail_folders SET name_enc = ?, special_use = ?, uid_validity = ? WHERE id = ?',
                    [nameEnc, specialUse, uidValidity, existing.id]
                );
                return { ...existing, name_enc: nameEnc, special_use: specialUse, uid_validity: uidValidity };
            }
            const posRows = await q.query<{ next: number }>(
                'SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM mail_folders WHERE account_id = ?',
                [accountId]
            );
            const res = await q.execute(
                `INSERT INTO mail_folders (account_id, imap_path, name_enc, special_use, sort_order, uid_validity)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [accountId, imapPath, nameEnc, specialUse, Number(posRows[0]?.next ?? 0), uidValidity]
            );
            const rows = await q.query<MailFolderRow>('SELECT * FROM mail_folders WHERE id = ?', [res.insertId]);
            return rows[0];
        },
        async updateCounts(id, { uidValidity, lastSeenUid, firstSeenUid, unreadCount, totalCount }) {
            await q.execute(
                `UPDATE mail_folders
                 SET uid_validity = ?, last_seen_uid = ?, first_seen_uid = ?, unread_count = ?, total_count = ?
                 WHERE id = ?`,
                [uidValidity, lastSeenUid, firstSeenUid, unreadCount, totalCount, id]
            );
        },
        async reorder(accountId, ids) {
            for (let i = 0; i < ids.length; i++) {
                await q.execute('UPDATE mail_folders SET sort_order = ? WHERE id = ? AND account_id = ?', [
                    i,
                    ids[i],
                    accountId
                ]);
            }
        },
        async updateNameEnc(id, nameEnc) {
            await q.execute('UPDATE mail_folders SET name_enc = ? WHERE id = ?', [nameEnc, id]);
        }
    };
}

function messagesRepo(q: SdkQueryable): MailMessagesRepo {
    return {
        async countByFolder(folderId) {
            const rows = await q.query<{ total: number; unseen: number }>(
                'SELECT COUNT(*) AS total, SUM(seen = 0) AS unseen FROM mail_messages WHERE folder_id = ?',
                [folderId]
            );
            const row = rows[0];
            return { total: Number(row?.total ?? 0), unseen: Number(row?.unseen ?? 0) };
        },
        async minUidByFolder(folderId) {
            const rows = await q.query<{ minUid: number | null }>(
                'SELECT MIN(uid) AS minUid FROM mail_messages WHERE folder_id = ?',
                [folderId]
            );
            const uid = rows[0]?.minUid;
            return uid === null || uid === undefined ? null : Number(uid);
        },
        async listByFolder(folderId, cursor, limit) {
            const where = ['folder_id = ?'];
            const params: unknown[] = [folderId];
            if (cursor !== null) {
                // Row-value comparison: strictly "older than the last row of the
                // previous page", with `id` deciding between two equal dates.
                where.push('(date, id) < (?, ?)');
                params.push(cursor.date, cursor.id);
            }
            return q.query<MailMessageRow>(
                `SELECT * FROM mail_messages WHERE ${where.join(' AND ')} ORDER BY date DESC, id DESC LIMIT ?`,
                [...params, limit]
            );
        },
        async findById(id) {
            const rows = await q.query<MailMessageRow>('SELECT * FROM mail_messages WHERE id = ?', [id]);
            return rows[0] ?? null;
        },
        async listAllByFolder(folderId) {
            return q.query<MailMessageRow>('SELECT * FROM mail_messages WHERE folder_id = ?', [folderId]);
        },
        async listForSearch(folderId, limit) {
            return q.query<MailMessageRow>(
                'SELECT * FROM mail_messages WHERE folder_id = ? ORDER BY date DESC, id DESC LIMIT ?',
                [folderId, limit]
            );
        },
        async listByFolderUids(folderId, uids) {
            if (uids.length === 0) return [];
            return q.query<MailMessageRow>(
                `SELECT * FROM mail_messages WHERE folder_id = ? AND uid IN (${uids.map(() => '?').join(',')})`,
                [folderId, ...uids]
            );
        },
        async listFlagsWindow(folderId, limit) {
            return q.query<MailMessageFlagsRow>(
                'SELECT id, uid, seen, flagged, answered FROM mail_messages WHERE folder_id = ? ORDER BY uid DESC LIMIT ?',
                [folderId, limit]
            );
        },
        async updateEnvelopeEnc(id, envelopeEnc) {
            await q.execute('UPDATE mail_messages SET envelope_enc = ? WHERE id = ?', [envelopeEnc, id]);
        },
        async upsertEnvelope({ folderId, uid, envelopeEnc, date, seen, flagged, answered, hasAttachments }) {
            await q.execute(
                `INSERT INTO mail_messages (folder_id, uid, envelope_enc, date, seen, flagged, answered, has_attachments)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                     envelope_enc    = VALUES(envelope_enc),
                     date            = VALUES(date),
                     seen            = VALUES(seen),
                     flagged         = VALUES(flagged),
                     answered        = VALUES(answered),
                     has_attachments = VALUES(has_attachments)`,
                [
                    folderId,
                    uid,
                    envelopeEnc,
                    date,
                    seen ? 1 : 0,
                    flagged ? 1 : 0,
                    answered ? 1 : 0,
                    hasAttachments ? 1 : 0
                ]
            );
            const rows = await q.query<MailMessageRow>('SELECT * FROM mail_messages WHERE folder_id = ? AND uid = ?', [
                folderId,
                uid
            ]);
            return rows[0];
        },
        async setFlags(id, flags) {
            const sets: string[] = [];
            const params: unknown[] = [];
            if (flags.seen !== undefined) {
                sets.push('seen = ?');
                params.push(flags.seen ? 1 : 0);
            }
            if (flags.flagged !== undefined) {
                sets.push('flagged = ?');
                params.push(flags.flagged ? 1 : 0);
            }
            if (flags.answered !== undefined) {
                sets.push('answered = ?');
                params.push(flags.answered ? 1 : 0);
            }
            if (sets.length === 0) return this.findById(id);
            params.push(id);
            await q.execute(`UPDATE mail_messages SET ${sets.join(', ')} WHERE id = ?`, params);
            return this.findById(id);
        },
        async updateFlags(id, { seen, flagged, answered }) {
            await q.execute('UPDATE mail_messages SET seen = ?, flagged = ?, answered = ? WHERE id = ?', [
                seen ? 1 : 0,
                flagged ? 1 : 0,
                answered ? 1 : 0,
                id
            ]);
        },
        async moveFolder(id, toFolderId, newUid) {
            await q.execute('UPDATE mail_messages SET folder_id = ?, uid = ? WHERE id = ?', [toFolderId, newUid, id]);
        },
        async delete(id) {
            const res = await q.execute('DELETE FROM mail_messages WHERE id = ?', [id]);
            return res.affectedRows > 0;
        },
        async deleteByFolder(folderId) {
            await q.execute('DELETE FROM mail_messages WHERE folder_id = ?', [folderId]);
        },
        async deleteByFolderUids(folderId, uids) {
            if (uids.length === 0) return 0;
            const res = await q.execute(
                `DELETE FROM mail_messages WHERE folder_id = ? AND uid IN (${uids.map(() => '?').join(',')})`,
                [folderId, ...uids]
            );
            return res.affectedRows;
        }
    };
}

function settingsRepo(q: SdkQueryable): MailSettingsRepo {
    return {
        async get(workspaceId) {
            const rows = await q.query<MailSettingsRow>('SELECT * FROM mail_settings WHERE workspace_id = ?', [
                workspaceId
            ]);
            return rows[0] ?? null;
        },
        async set(workspaceId, { externalScanEnabledDefault, trustedImageDomains, bodyRenderMode }) {
            await q.execute(
                `INSERT INTO mail_settings
                     (workspace_id, external_scan_enabled_default, trusted_image_domains, body_render_mode)
                 VALUES (?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                     external_scan_enabled_default = VALUES(external_scan_enabled_default),
                     trusted_image_domains         = VALUES(trusted_image_domains),
                     body_render_mode              = VALUES(body_render_mode)`,
                [
                    workspaceId,
                    externalScanEnabledDefault ? 1 : 0,
                    trustedImageDomains.length > 0 ? JSON.stringify(trustedImageDomains) : null,
                    bodyRenderMode
                ]
            );
            const row = await this.get(workspaceId);
            if (!row) throw new Error('Failed to persist mail settings');
            return row;
        }
    };
}

export function createRepo(q: SdkQueryable): MailRepo {
    return { accounts: accountsRepo(q), folders: foldersRepo(q), messages: messagesRepo(q), settings: settingsRepo(q) };
}
