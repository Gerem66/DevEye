import type {
    MailAccountRow,
    MailAuthMethod,
    MailBodyRenderMode,
    MailFolderRow,
    MailFolderSpecialUse,
    MailMessageCursor,
    MailMessageRow,
    MailSecurityTier,
    MailSettingsRow
} from 'deveye-types';
import type { Queryable } from '../pool';

type Q = Queryable;

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
    listByUser(userId: number): Promise<MailAccountRow[]>;
    findById(id: number, userId: number): Promise<MailAccountRow | null>;
    /** Unscoped read for the background sync loop, which has no live user session. */
    findByIdUnscoped(id: number): Promise<MailAccountRow | null>;
    create(input: { userId: number } & MailAccountConfig): Promise<MailAccountRow>;
    update(id: number, userId: number, input: MailAccountConfig): Promise<MailAccountRow | null>;
    setEnabled(id: number, userId: number, enabled: boolean): Promise<MailAccountRow | null>;
    delete(id: number, userId: number): Promise<boolean>;
    /** Lay out the user's accounts in the given order — same convention as `uptime.reorder`. */
    reorder(userId: number, ids: number[]): Promise<void>;
    count(userId: number): Promise<number>;
    /** Write back a sync outcome (background loop or on-demand). */
    recordSync(id: number, lastSyncAt: number, lastSyncErrorEnc: string | null): Promise<void>;
    /** Persist a refreshed OAuth token blob without touching anything else. */
    updateCredentials(id: number, credentialsEnc: string): Promise<void>;
    /** Re-key the cached error alone, when a tier switch changes which cipher it must be under. */
    updateSyncError(id: number, lastSyncErrorEnc: string | null): Promise<void>;
    /**
     * Enabled, "open"-tier accounts due for a background sync tick (never
     * "guarded" — those only sync on demand during a live session). Staleness
     * is per account, from its own `sync_interval_seconds`.
     */
    listSyncDue(now: number, limit: number): Promise<MailAccountRow[]>;
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

export interface MailMessagesRepo {
    /** Counts from the cache, used to keep `mail_folders.unread_count/total_count` in step after a sync. */
    countByFolder(folderId: number): Promise<{ total: number; unseen: number }>;
    /** Lowest cached UID, or null if empty — backstops `mail_folders.first_seen_uid` for rows predating it. */
    minUidByFolder(folderId: number): Promise<number | null>;
    /**
     * Newest **by date** first, paged on `(date, id)`.
     *
     * Not by row id: ids are insertion order, and the cache is not filled in
     * date order. Backfill (and remote search) write older messages into it
     * after newer ones, so `ORDER BY id DESC` surfaced freshly-fetched *old*
     * mail at the top of the mailbox. `id` only breaks ties between equal
     * dates, which keeps the page boundary exact — no repeated or skipped row.
     */
    listByFolder(folderId: number, cursor: MailMessageCursor | null, limit: number): Promise<MailMessageRow[]>;
    findById(id: number): Promise<MailMessageRow | null>;
    /** Every cached row of a folder, unpaged — only for a tier switch's re-key pass. */
    listAllByFolder(folderId: number): Promise<MailMessageRow[]>;
    /**
     * Newest-first scan surface for `mail.messageSearch`, capped by `limit`.
     * Unlike {@link listByFolder} this is not a page of results but the set of
     * rows the handler will decrypt to look inside — the envelopes are
     * encrypted, so the filtering cannot happen in SQL.
     */
    listForSearch(folderId: number, limit: number): Promise<MailMessageRow[]>;
    /** Cached rows for specific UIDs — how a remote search finds which of its hits it already holds. */
    listByFolderUids(folderId: number, uids: number[]): Promise<MailMessageRow[]>;
    /** Re-key one cached envelope, for a tier switch. */
    updateEnvelopeEnc(id: number, envelopeEnc: string): Promise<void>;
    /** Create or refresh the cached envelope for `(folderId, uid)`. */
    upsertEnvelope(input: MailMessageEnvelopeInput): Promise<MailMessageRow>;
    setFlags(
        id: number,
        flags: Partial<{ seen: boolean; flagged: boolean; answered: boolean }>
    ): Promise<MailMessageRow | null>;
    moveFolder(id: number, toFolderId: number, newUid: number): Promise<void>;
    delete(id: number): Promise<boolean>;
    /** Drops every cached message of a folder — used when UIDVALIDITY changes. */
    deleteByFolder(folderId: number): Promise<void>;
}

export interface MailSettingsRepo {
    get(userId: number): Promise<MailSettingsRow | null>;
    set(
        userId: number,
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

export function mailAccountsRepo(pool: Q): MailAccountsRepo {
    async function reload(id: number, userId: number): Promise<MailAccountRow | null> {
        const r = await pool.query<MailAccountRow>('SELECT * FROM mail_accounts WHERE id = ? AND user_id = ?', [
            id,
            userId
        ]);
        return r.rows[0] ?? null;
    }

    return {
        async listByUser(userId) {
            const r = await pool.query<MailAccountRow>(
                'SELECT * FROM mail_accounts WHERE user_id = ? ORDER BY sort_order ASC, id ASC',
                [userId]
            );
            return r.rows;
        },
        findById: reload,
        async findByIdUnscoped(id) {
            const r = await pool.query<MailAccountRow>('SELECT * FROM mail_accounts WHERE id = ?', [id]);
            return r.rows[0] ?? null;
        },
        async create({ userId, ...config }) {
            // New accounts land at the end of the list, never in the middle.
            const posRow = await pool.query<{ next: number }>(
                'SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM mail_accounts WHERE user_id = ?',
                [userId]
            );
            const res = await pool.query(
                `INSERT INTO mail_accounts
                     (user_id, display_name_enc, email_address_enc, security_tier, auth_method,
                      credentials_enc, enabled, sync_interval_seconds, sort_order)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [userId, ...accountConfigParams(config), Number(posRow.rows[0]?.next ?? 0)]
            );
            const r = await pool.query<MailAccountRow>('SELECT * FROM mail_accounts WHERE id = ?', [res.insertId]);
            return r.rows[0];
        },
        async update(id, userId, config) {
            const res = await pool.query(
                `UPDATE mail_accounts
                 SET display_name_enc = ?, email_address_enc = ?, security_tier = ?, auth_method = ?,
                     credentials_enc = ?, enabled = ?, sync_interval_seconds = ?
                 WHERE id = ? AND user_id = ?`,
                [...accountConfigParams(config), id, userId]
            );
            if (res.rowCount === 0) return null;
            return reload(id, userId);
        },
        async setEnabled(id, userId, enabled) {
            const res = await pool.query('UPDATE mail_accounts SET enabled = ? WHERE id = ? AND user_id = ?', [
                enabled ? 1 : 0,
                id,
                userId
            ]);
            if (res.rowCount === 0) return null;
            return reload(id, userId);
        },
        async delete(id, userId) {
            const r = await pool.query('DELETE FROM mail_accounts WHERE id = ? AND user_id = ?', [id, userId]);
            return r.rowCount > 0;
        },
        async reorder(userId, ids) {
            for (let i = 0; i < ids.length; i++) {
                await pool.query('UPDATE mail_accounts SET sort_order = ? WHERE id = ? AND user_id = ?', [
                    i,
                    ids[i],
                    userId
                ]);
            }
        },
        async count(userId) {
            const r = await pool.query<{ total: number }>(
                'SELECT COUNT(*) AS total FROM mail_accounts WHERE user_id = ?',
                [userId]
            );
            return Number(r.rows[0]?.total ?? 0);
        },
        async recordSync(id, lastSyncAt, lastSyncErrorEnc) {
            await pool.query('UPDATE mail_accounts SET last_sync_at = ?, last_sync_error_enc = ? WHERE id = ?', [
                lastSyncAt,
                lastSyncErrorEnc,
                id
            ]);
        },
        async updateCredentials(id, credentialsEnc) {
            await pool.query('UPDATE mail_accounts SET credentials_enc = ? WHERE id = ?', [credentialsEnc, id]);
        },
        async updateSyncError(id, lastSyncErrorEnc) {
            await pool.query('UPDATE mail_accounts SET last_sync_error_enc = ? WHERE id = ?', [lastSyncErrorEnc, id]);
        },
        async listSyncDue(now, limit) {
            const r = await pool.query<MailAccountRow>(
                `SELECT * FROM mail_accounts
                 WHERE enabled = 1 AND security_tier = 'open'
                   AND (last_sync_at IS NULL OR last_sync_at <= ? - sync_interval_seconds)
                 ORDER BY last_sync_at IS NOT NULL, last_sync_at ASC
                 LIMIT ?`,
                [now, limit]
            );
            return r.rows;
        }
    };
}

export function mailFoldersRepo(pool: Q): MailFoldersRepo {
    return {
        async listByAccount(accountId) {
            const r = await pool.query<MailFolderRow>(
                'SELECT * FROM mail_folders WHERE account_id = ? ORDER BY sort_order ASC, id ASC',
                [accountId]
            );
            return r.rows;
        },
        async findById(id) {
            const r = await pool.query<MailFolderRow>('SELECT * FROM mail_folders WHERE id = ?', [id]);
            return r.rows[0] ?? null;
        },
        async findByImapPath(accountId, imapPath) {
            const r = await pool.query<MailFolderRow>(
                'SELECT * FROM mail_folders WHERE account_id = ? AND imap_path = ?',
                [accountId, imapPath]
            );
            return r.rows[0] ?? null;
        },
        async upsert({ accountId, imapPath, nameEnc, specialUse, uidValidity }) {
            const existing = await this.findByImapPath(accountId, imapPath);
            if (existing) {
                await pool.query(
                    'UPDATE mail_folders SET name_enc = ?, special_use = ?, uid_validity = ? WHERE id = ?',
                    [nameEnc, specialUse, uidValidity, existing.id]
                );
                return { ...existing, name_enc: nameEnc, special_use: specialUse, uid_validity: uidValidity };
            }
            const posRow = await pool.query<{ next: number }>(
                'SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM mail_folders WHERE account_id = ?',
                [accountId]
            );
            const res = await pool.query(
                `INSERT INTO mail_folders (account_id, imap_path, name_enc, special_use, sort_order, uid_validity)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [accountId, imapPath, nameEnc, specialUse, Number(posRow.rows[0]?.next ?? 0), uidValidity]
            );
            const r = await pool.query<MailFolderRow>('SELECT * FROM mail_folders WHERE id = ?', [res.insertId]);
            return r.rows[0];
        },
        async updateCounts(id, { uidValidity, lastSeenUid, firstSeenUid, unreadCount, totalCount }) {
            await pool.query(
                `UPDATE mail_folders
                 SET uid_validity = ?, last_seen_uid = ?, first_seen_uid = ?, unread_count = ?, total_count = ?
                 WHERE id = ?`,
                [uidValidity, lastSeenUid, firstSeenUid, unreadCount, totalCount, id]
            );
        },
        async reorder(accountId, ids) {
            for (let i = 0; i < ids.length; i++) {
                await pool.query('UPDATE mail_folders SET sort_order = ? WHERE id = ? AND account_id = ?', [
                    i,
                    ids[i],
                    accountId
                ]);
            }
        },
        async updateNameEnc(id, nameEnc) {
            await pool.query('UPDATE mail_folders SET name_enc = ? WHERE id = ?', [nameEnc, id]);
        }
    };
}

export function mailMessagesRepo(pool: Q): MailMessagesRepo {
    return {
        async countByFolder(folderId) {
            const r = await pool.query<{ total: number; unseen: number }>(
                'SELECT COUNT(*) AS total, SUM(seen = 0) AS unseen FROM mail_messages WHERE folder_id = ?',
                [folderId]
            );
            const row = r.rows[0];
            return { total: Number(row?.total ?? 0), unseen: Number(row?.unseen ?? 0) };
        },
        async minUidByFolder(folderId) {
            const r = await pool.query<{ minUid: number | null }>(
                'SELECT MIN(uid) AS minUid FROM mail_messages WHERE folder_id = ?',
                [folderId]
            );
            const uid = r.rows[0]?.minUid;
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
            const r = await pool.query<MailMessageRow>(
                `SELECT * FROM mail_messages WHERE ${where.join(' AND ')} ORDER BY date DESC, id DESC LIMIT ?`,
                [...params, limit]
            );
            return r.rows;
        },
        async findById(id) {
            const r = await pool.query<MailMessageRow>('SELECT * FROM mail_messages WHERE id = ?', [id]);
            return r.rows[0] ?? null;
        },
        async listAllByFolder(folderId) {
            const r = await pool.query<MailMessageRow>('SELECT * FROM mail_messages WHERE folder_id = ?', [folderId]);
            return r.rows;
        },
        async listForSearch(folderId, limit) {
            const r = await pool.query<MailMessageRow>(
                'SELECT * FROM mail_messages WHERE folder_id = ? ORDER BY date DESC, id DESC LIMIT ?',
                [folderId, limit]
            );
            return r.rows;
        },
        async listByFolderUids(folderId, uids) {
            if (uids.length === 0) return [];
            const r = await pool.query<MailMessageRow>(
                `SELECT * FROM mail_messages WHERE folder_id = ? AND uid IN (${uids.map(() => '?').join(',')})`,
                [folderId, ...uids]
            );
            return r.rows;
        },
        async updateEnvelopeEnc(id, envelopeEnc) {
            await pool.query('UPDATE mail_messages SET envelope_enc = ? WHERE id = ?', [envelopeEnc, id]);
        },
        async upsertEnvelope({ folderId, uid, envelopeEnc, date, seen, flagged, answered, hasAttachments }) {
            await pool.query(
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
            const r = await pool.query<MailMessageRow>('SELECT * FROM mail_messages WHERE folder_id = ? AND uid = ?', [
                folderId,
                uid
            ]);
            return r.rows[0];
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
            await pool.query(`UPDATE mail_messages SET ${sets.join(', ')} WHERE id = ?`, params);
            return this.findById(id);
        },
        async moveFolder(id, toFolderId, newUid) {
            await pool.query('UPDATE mail_messages SET folder_id = ?, uid = ? WHERE id = ?', [toFolderId, newUid, id]);
        },
        async delete(id) {
            const r = await pool.query('DELETE FROM mail_messages WHERE id = ?', [id]);
            return r.rowCount > 0;
        },
        async deleteByFolder(folderId) {
            await pool.query('DELETE FROM mail_messages WHERE folder_id = ?', [folderId]);
        }
    };
}

export function mailSettingsRepo(pool: Q): MailSettingsRepo {
    return {
        async get(userId) {
            const r = await pool.query<MailSettingsRow>('SELECT * FROM mail_settings WHERE user_id = ?', [userId]);
            return r.rows[0] ?? null;
        },
        async set(userId, { externalScanEnabledDefault, trustedImageDomains, bodyRenderMode }) {
            await pool.query(
                `INSERT INTO mail_settings
                     (user_id, external_scan_enabled_default, trusted_image_domains, body_render_mode)
                 VALUES (?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                     external_scan_enabled_default = VALUES(external_scan_enabled_default),
                     trusted_image_domains         = VALUES(trusted_image_domains),
                     body_render_mode              = VALUES(body_render_mode)`,
                [
                    userId,
                    externalScanEnabledDefault ? 1 : 0,
                    trustedImageDomains.length > 0 ? JSON.stringify(trustedImageDomains) : null,
                    bodyRenderMode
                ]
            );
            const row = await this.get(userId);
            if (!row) throw new Error('Failed to persist mail settings');
            return row;
        }
    };
}
