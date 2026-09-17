import type { SdkQueryable } from '@deveye/types/sdk/server';

/**
 * Tout le SQL du module. Le dépôt ne chiffre rien : `content`, `meta`,
 * `blob_key` et `private_key` arrivent déjà scellés. Il ne filtre pas non plus
 * par espace à la place de l'appelant : chaque lecture d'une commande porte
 * son `workspaceId`, celles du moteur partent d'une adresse ou d'un id qu'il a
 * lui-même résolu.
 */

export interface MailboxRow {
    id: number;
    workspace_id: number;
    domain_id: number;
    local_part: string;
    address: string;
    enabled: number;
    password_hash: string;
    password_set_at: number;
    quota_bytes: number;
    used_bytes: number;
    message_count: number;
    outbound_daily_limit: number;
    blob_key: string;
    banner_dismissed: number;
    last_delivery_at: number | null;
    last_login_at: number | null;
    content: string;
    created: number;
}

export interface CredentialRow {
    id: number;
    mailbox_id: number;
    label: string;
    secret_hash: string;
    origin: 'user' | 'mails';
    save_sent: number;
    created: number;
    created_by: number;
    last_used_at: number | null;
}

export interface FolderRow {
    id: number;
    mailbox_id: number;
    path: string;
    special_use: string | null;
    uid_validity: number;
    uid_next: number;
    subscribed: number;
}

export interface BlobRow {
    id: number;
    mailbox_id: number;
    ref: string;
    size: number;
    refs: number;
}

/** Un message sans sa structure : ce qu'une session IMAP garde de tout un dossier. */
export interface MessageRow {
    id: number;
    mailbox_id: number;
    folder_id: number;
    uid: number;
    flags: number;
    keywords: string;
    internal_date: number;
    size: number;
    blob_id: number;
}

export interface QueueRow {
    id: number;
    workspace_id: number;
    mailbox_id: number;
    blob_id: number;
    status: 'queued' | 'sending' | 'deferred';
    attempts: number;
    next_attempt_at: number;
    created: number;
    content: string;
}

export interface DomainKeyRow {
    id: number;
    workspace_id: number;
    host: string;
    selector: string;
    private_key: string;
    public_key: string;
}

export interface EventRow {
    id: number;
    mailbox_id: number;
    ts: number;
    kind: string;
    size: number;
    spf: number;
    dkim: number;
    dmarc: number;
    content: string;
}

export interface DailyRow {
    mailbox_id: number;
    day: string;
    received: number;
    sent: number;
    rejected: number;
    bounced: number;
}

export type DailyColumn = 'received' | 'sent' | 'rejected' | 'bounced';

export interface TlsRow {
    hostname: string;
    kind: 'account' | 'certificate';
    directory: 'production' | 'staging';
    sealed: string;
    cert_pem: string | null;
    not_after: number | null;
}

export interface MailserverRepo {
    /** Les boîtes de l'espace, et celles que d'autres espaces y projettent. */
    listVisible(workspaceId: number): Promise<MailboxRow[]>;
    findVisible(id: number, workspaceId: number): Promise<MailboxRow | null>;
    find(id: number, workspaceId: number): Promise<MailboxRow | null>;
    findById(id: number): Promise<MailboxRow | null>;
    findByAddress(address: string): Promise<MailboxRow | null>;
    createMailbox(input: {
        workspaceId: number;
        domainId: number;
        localPart: string;
        address: string;
        passwordHash: string;
        quotaBytes: number;
        outboundDailyLimit: number;
        blobKey: string;
        content: string;
        now: number;
    }): Promise<number>;
    updateMailbox(
        id: number,
        patch: { enabled: boolean; quotaBytes: number; outboundDailyLimit: number; content: string }
    ): Promise<void>;
    setBanner(id: number, dismissed: boolean): Promise<void>;
    setPassword(id: number, hash: string, now: number): Promise<void>;
    deleteMailbox(id: number): Promise<void>;
    countByDomain(workspaceId: number): Promise<Map<number, number>>;
    touchLogin(id: number, now: number): Promise<void>;
    touchDelivery(id: number, now: number): Promise<void>;
    adjustUsage(id: number, bytes: number, messages: number): Promise<void>;
    /** Une valeur d'UIDVALIDITY jamais rendue pour cette boîte. */
    nextUidValidity(id: number): Promise<number>;

    listCredentials(mailboxId: number): Promise<CredentialRow[]>;
    createCredential(input: {
        mailboxId: number;
        label: string;
        secretHash: string;
        origin: 'user' | 'mails';
        saveSent: boolean;
        createdBy: number;
        now: number;
    }): Promise<number>;
    deleteCredential(id: number, mailboxId: number): Promise<boolean>;
    touchCredential(id: number, now: number): Promise<void>;

    listFolders(mailboxId: number): Promise<FolderRow[]>;
    findFolder(mailboxId: number, path: string): Promise<FolderRow | null>;
    findFolderById(id: number): Promise<FolderRow | null>;
    createFolder(input: {
        mailboxId: number;
        path: string;
        specialUse: string | null;
        uidValidity: number;
    }): Promise<number>;
    renameFolder(id: number, path: string): Promise<void>;
    deleteFolder(id: number): Promise<void>;
    setSubscribed(id: number, subscribed: boolean): Promise<void>;
    /** L'UID suivant du dossier, pris de façon atomique. */
    allocateUid(folderId: number): Promise<number>;

    createBlob(input: { mailboxId: number; ref: string; size: number }): Promise<number>;
    findBlob(id: number): Promise<BlobRow | null>;
    /** Ajoute `delta` aux références et rend ce qu'il en reste. */
    refBlob(id: number, delta: number): Promise<number>;
    deleteBlob(id: number): Promise<void>;

    insertMessage(input: {
        mailboxId: number;
        folderId: number;
        uid: number;
        flags: number;
        keywords: string;
        internalDate: number;
        size: number;
        blobId: number;
        meta: string;
    }): Promise<number>;
    listMessages(folderId: number): Promise<MessageRow[]>;
    findMessage(folderId: number, uid: number): Promise<MessageRow | null>;
    messageMeta(id: number): Promise<string | null>;
    setFlags(id: number, flags: number, keywords: string): Promise<void>;
    deleteMessage(id: number): Promise<void>;

    enqueue(input: {
        workspaceId: number;
        mailboxId: number;
        blobId: number;
        content: string;
        now: number;
    }): Promise<number>;
    dueQueue(now: number, limit: number): Promise<QueueRow[]>;
    /** Prend la ligne pour ce tour ; faux si un autre tour l'a déjà. */
    claimQueue(id: number): Promise<boolean>;
    deferQueue(id: number, attempts: number, nextAttemptAt: number, content: string): Promise<void>;
    retryQueueNow(id: number, now: number): Promise<void>;
    removeQueue(id: number): Promise<void>;
    findQueue(id: number): Promise<QueueRow | null>;
    listQueue(workspaceId: number, mailboxId: number | null): Promise<QueueRow[]>;
    /** Les lignes restées « en cours » à l'arrêt du processus reprennent leur place. */
    requeueStuck(): Promise<void>;
    queueCounts(mailboxId: number): Promise<{ queued: number; deferred: number }>;
    queueDepth(): Promise<number>;

    findDomainKey(host: string): Promise<DomainKeyRow | null>;
    insertDomainKey(input: {
        workspaceId: number;
        host: string;
        selector: string;
        privateKey: string;
        publicKey: string;
    }): Promise<void>;

    insertEvent(input: {
        mailboxId: number;
        ts: number;
        kind: string;
        size: number;
        spf: number;
        dkim: number;
        dmarc: number;
        content: string;
    }): Promise<void>;
    recentEvents(mailboxId: number, limit: number): Promise<EventRow[]>;
    purgeEvents(before: number): Promise<number>;
    bumpDaily(mailboxId: number, day: string, column: DailyColumn): Promise<void>;
    dailySince(mailboxId: number, day: string): Promise<DailyRow[]>;
    sentOn(mailboxId: number, day: string): Promise<number>;

    getTls(hostname: string, kind: TlsRow['kind'], directory: TlsRow['directory']): Promise<TlsRow | null>;
    putTls(row: TlsRow): Promise<void>;
}

const MAILBOX_COLUMNS =
    'm.id, m.workspace_id, m.domain_id, m.local_part, m.address, m.enabled, m.password_hash, ' +
    'm.password_set_at, m.quota_bytes, m.used_bytes, m.message_count, m.outbound_daily_limit, m.blob_key, ' +
    'm.banner_dismissed, m.last_delivery_at, m.last_login_at, m.content, m.created';

const MESSAGE_COLUMNS = 'id, mailbox_id, folder_id, uid, flags, keywords, internal_date, size, blob_id';

const nullable = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

/** mysql2 rend un BIGINT en chaîne selon la config du pool : tout passe par `Number`. */
function mailbox(row: MailboxRow): MailboxRow {
    return {
        ...row,
        password_set_at: Number(row.password_set_at),
        quota_bytes: Number(row.quota_bytes),
        used_bytes: Number(row.used_bytes),
        last_delivery_at: nullable(row.last_delivery_at),
        last_login_at: nullable(row.last_login_at),
        created: Number(row.created)
    };
}

function message(row: MessageRow): MessageRow {
    return { ...row, id: Number(row.id), internal_date: Number(row.internal_date), blob_id: Number(row.blob_id) };
}

function queue(row: QueueRow): QueueRow {
    return {
        ...row,
        id: Number(row.id),
        blob_id: Number(row.blob_id),
        next_attempt_at: Number(row.next_attempt_at),
        created: Number(row.created)
    };
}

const one = <T>(rows: T[]): T | null => rows[0] ?? null;

export function createRepo(q: SdkQueryable): MailserverRepo {
    const findById = async (id: number): Promise<MailboxRow | null> => {
        const row = one(
            await q.query<MailboxRow>(`SELECT ${MAILBOX_COLUMNS} FROM ft_mailserver_mailboxes m WHERE m.id = ?`, [id])
        );
        return row ? mailbox(row) : null;
    };

    return {
        async listVisible(workspaceId) {
            const rows = await q.query<MailboxRow>(
                `SELECT ${MAILBOX_COLUMNS} FROM ft_mailserver_mailboxes m WHERE m.workspace_id = ?
                 UNION
                 SELECT ${MAILBOX_COLUMNS} FROM ft_mailserver_mailboxes m
                   JOIN item_shares sh
                     ON sh.feature = 'mailserver' AND sh.item_id = m.id AND sh.home_workspace_id = m.workspace_id
                  WHERE sh.workspace_id = ?
                  ORDER BY address ASC`,
                [workspaceId, workspaceId]
            );
            return rows.map(mailbox);
        },

        async findVisible(id, workspaceId) {
            const row = one(
                await q.query<MailboxRow>(
                    `SELECT ${MAILBOX_COLUMNS} FROM ft_mailserver_mailboxes m
                      WHERE m.id = ?
                        AND (m.workspace_id = ?
                             OR EXISTS (SELECT 1 FROM item_shares sh
                                         WHERE sh.feature = 'mailserver' AND sh.item_id = m.id
                                           AND sh.home_workspace_id = m.workspace_id
                                           AND sh.workspace_id = ?))`,
                    [id, workspaceId, workspaceId]
                )
            );
            return row ? mailbox(row) : null;
        },

        async find(id, workspaceId) {
            const row = await findById(id);
            return row && row.workspace_id === workspaceId ? row : null;
        },

        findById,

        async findByAddress(address) {
            const row = one(
                await q.query<MailboxRow>(
                    `SELECT ${MAILBOX_COLUMNS} FROM ft_mailserver_mailboxes m WHERE m.address = ?`,
                    [address]
                )
            );
            return row ? mailbox(row) : null;
        },

        async createMailbox(input) {
            const res = await q.execute(
                `INSERT INTO ft_mailserver_mailboxes
                    (workspace_id, domain_id, local_part, address, password_hash, password_set_at,
                     quota_bytes, outbound_daily_limit, blob_key, content, created)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    input.workspaceId,
                    input.domainId,
                    input.localPart,
                    input.address,
                    input.passwordHash,
                    input.now,
                    input.quotaBytes,
                    input.outboundDailyLimit,
                    input.blobKey,
                    input.content,
                    input.now
                ]
            );
            return res.insertId;
        },

        async updateMailbox(id, patch) {
            await q.execute(
                `UPDATE ft_mailserver_mailboxes
                    SET enabled = ?, quota_bytes = ?, outbound_daily_limit = ?, content = ? WHERE id = ?`,
                [patch.enabled ? 1 : 0, patch.quotaBytes, patch.outboundDailyLimit, patch.content, id]
            );
        },

        async setBanner(id, dismissed) {
            await q.execute('UPDATE ft_mailserver_mailboxes SET banner_dismissed = ? WHERE id = ?', [
                dismissed ? 1 : 0,
                id
            ]);
        },

        async setPassword(id, hash, now) {
            await q.execute('UPDATE ft_mailserver_mailboxes SET password_hash = ?, password_set_at = ? WHERE id = ?', [
                hash,
                now,
                id
            ]);
        },

        async deleteMailbox(id) {
            await q.execute('DELETE FROM ft_mailserver_mailboxes WHERE id = ?', [id]);
        },

        async countByDomain(workspaceId) {
            const rows = await q.query<{ domain_id: number; total: number }>(
                'SELECT domain_id, COUNT(*) AS total FROM ft_mailserver_mailboxes WHERE workspace_id = ? GROUP BY domain_id',
                [workspaceId]
            );
            return new Map(rows.map((r) => [Number(r.domain_id), Number(r.total)]));
        },

        async touchLogin(id, now) {
            await q.execute('UPDATE ft_mailserver_mailboxes SET last_login_at = ? WHERE id = ?', [now, id]);
        },

        async touchDelivery(id, now) {
            await q.execute('UPDATE ft_mailserver_mailboxes SET last_delivery_at = ? WHERE id = ?', [now, id]);
        },

        async adjustUsage(id, bytes, messages) {
            await q.execute(
                `UPDATE ft_mailserver_mailboxes
                    SET used_bytes = GREATEST(0, CAST(used_bytes AS SIGNED) + ?),
                        message_count = GREATEST(0, CAST(message_count AS SIGNED) + ?)
                  WHERE id = ?`,
                [bytes, messages, id]
            );
        },

        async nextUidValidity(id) {
            // `LAST_INSERT_ID(expr)` revient dans l'en-tête de la réponse : la
            // valeur est lue sans seconde requête, donc sans dépendre de la
            // connexion du pool qui a servi l'écriture.
            const res = await q.execute(
                'UPDATE ft_mailserver_mailboxes SET uid_validity_seq = LAST_INSERT_ID(uid_validity_seq + 1) WHERE id = ?',
                [id]
            );
            return res.insertId - 1;
        },

        async listCredentials(mailboxId) {
            const rows = await q.query<CredentialRow>(
                'SELECT * FROM ft_mailserver_credentials WHERE mailbox_id = ? ORDER BY id',
                [mailboxId]
            );
            return rows.map((row) => ({
                ...row,
                created: Number(row.created),
                last_used_at: nullable(row.last_used_at)
            }));
        },

        async createCredential(input) {
            const res = await q.execute(
                `INSERT INTO ft_mailserver_credentials
                    (mailbox_id, label, secret_hash, origin, save_sent, created, created_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [
                    input.mailboxId,
                    input.label,
                    input.secretHash,
                    input.origin,
                    input.saveSent ? 1 : 0,
                    input.now,
                    input.createdBy
                ]
            );
            return res.insertId;
        },

        async deleteCredential(id, mailboxId) {
            const res = await q.execute('DELETE FROM ft_mailserver_credentials WHERE id = ? AND mailbox_id = ?', [
                id,
                mailboxId
            ]);
            return res.affectedRows > 0;
        },

        async touchCredential(id, now) {
            await q.execute('UPDATE ft_mailserver_credentials SET last_used_at = ? WHERE id = ?', [now, id]);
        },

        listFolders: (mailboxId) =>
            q.query<FolderRow>('SELECT * FROM ft_mailserver_folders WHERE mailbox_id = ? ORDER BY path', [mailboxId]),

        async findFolder(mailboxId, path) {
            return one(
                await q.query<FolderRow>('SELECT * FROM ft_mailserver_folders WHERE mailbox_id = ? AND path = ?', [
                    mailboxId,
                    path
                ])
            );
        },

        async findFolderById(id) {
            return one(await q.query<FolderRow>('SELECT * FROM ft_mailserver_folders WHERE id = ?', [id]));
        },

        async createFolder(input) {
            const res = await q.execute(
                'INSERT INTO ft_mailserver_folders (mailbox_id, path, special_use, uid_validity) VALUES (?, ?, ?, ?)',
                [input.mailboxId, input.path, input.specialUse, input.uidValidity]
            );
            return res.insertId;
        },

        async renameFolder(id, path) {
            await q.execute('UPDATE ft_mailserver_folders SET path = ? WHERE id = ?', [path, id]);
        },

        async deleteFolder(id) {
            await q.execute('DELETE FROM ft_mailserver_folders WHERE id = ?', [id]);
        },

        async setSubscribed(id, subscribed) {
            await q.execute('UPDATE ft_mailserver_folders SET subscribed = ? WHERE id = ?', [subscribed ? 1 : 0, id]);
        },

        async allocateUid(folderId) {
            const res = await q.execute(
                'UPDATE ft_mailserver_folders SET uid_next = LAST_INSERT_ID(uid_next + 1) WHERE id = ?',
                [folderId]
            );
            return res.insertId - 1;
        },

        async createBlob(input) {
            const res = await q.execute('INSERT INTO ft_mailserver_blobs (mailbox_id, ref, size) VALUES (?, ?, ?)', [
                input.mailboxId,
                input.ref,
                input.size
            ]);
            return res.insertId;
        },

        async findBlob(id) {
            const row = one(await q.query<BlobRow>('SELECT * FROM ft_mailserver_blobs WHERE id = ?', [id]));
            return row ? { ...row, id: Number(row.id) } : null;
        },

        async refBlob(id, delta) {
            await q.execute('UPDATE ft_mailserver_blobs SET refs = refs + ? WHERE id = ?', [delta, id]);
            const rows = await q.query<{ refs: number }>('SELECT refs FROM ft_mailserver_blobs WHERE id = ?', [id]);
            return Number(rows[0]?.refs ?? 0);
        },

        async deleteBlob(id) {
            await q.execute('DELETE FROM ft_mailserver_blobs WHERE id = ?', [id]);
        },

        async insertMessage(input) {
            const res = await q.execute(
                `INSERT INTO ft_mailserver_messages
                    (mailbox_id, folder_id, uid, flags, keywords, internal_date, size, blob_id, meta)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    input.mailboxId,
                    input.folderId,
                    input.uid,
                    input.flags,
                    input.keywords,
                    input.internalDate,
                    input.size,
                    input.blobId,
                    input.meta
                ]
            );
            return res.insertId;
        },

        async listMessages(folderId) {
            const rows = await q.query<MessageRow>(
                `SELECT ${MESSAGE_COLUMNS} FROM ft_mailserver_messages WHERE folder_id = ? ORDER BY uid`,
                [folderId]
            );
            return rows.map(message);
        },

        async findMessage(folderId, uid) {
            const row = one(
                await q.query<MessageRow>(
                    `SELECT ${MESSAGE_COLUMNS} FROM ft_mailserver_messages WHERE folder_id = ? AND uid = ?`,
                    [folderId, uid]
                )
            );
            return row ? message(row) : null;
        },

        async messageMeta(id) {
            const rows = await q.query<{ meta: string }>('SELECT meta FROM ft_mailserver_messages WHERE id = ?', [id]);
            return rows[0]?.meta ?? null;
        },

        async setFlags(id, flags, keywords) {
            await q.execute('UPDATE ft_mailserver_messages SET flags = ?, keywords = ? WHERE id = ?', [
                flags,
                keywords,
                id
            ]);
        },

        async deleteMessage(id) {
            await q.execute('DELETE FROM ft_mailserver_messages WHERE id = ?', [id]);
        },

        async enqueue(input) {
            const res = await q.execute(
                `INSERT INTO ft_mailserver_queue (workspace_id, mailbox_id, blob_id, next_attempt_at, created, content)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [input.workspaceId, input.mailboxId, input.blobId, input.now, input.now, input.content]
            );
            return res.insertId;
        },

        async dueQueue(now, limit) {
            const rows = await q.query<QueueRow>(
                `SELECT * FROM ft_mailserver_queue
                  WHERE status IN ('queued', 'deferred') AND next_attempt_at <= ?
                  ORDER BY next_attempt_at LIMIT ${Math.max(1, Math.floor(limit))}`,
                [now]
            );
            return rows.map(queue);
        },

        async claimQueue(id) {
            const res = await q.execute(
                "UPDATE ft_mailserver_queue SET status = 'sending' WHERE id = ? AND status IN ('queued', 'deferred')",
                [id]
            );
            return res.affectedRows > 0;
        },

        async deferQueue(id, attempts, nextAttemptAt, content) {
            await q.execute(
                "UPDATE ft_mailserver_queue SET status = 'deferred', attempts = ?, next_attempt_at = ?, content = ? WHERE id = ?",
                [attempts, nextAttemptAt, content, id]
            );
        },

        async retryQueueNow(id, now) {
            await q.execute(
                "UPDATE ft_mailserver_queue SET status = 'queued', next_attempt_at = ? WHERE id = ? AND status <> 'sending'",
                [now, id]
            );
        },

        async removeQueue(id) {
            await q.execute('DELETE FROM ft_mailserver_queue WHERE id = ?', [id]);
        },

        async findQueue(id) {
            const row = one(await q.query<QueueRow>('SELECT * FROM ft_mailserver_queue WHERE id = ?', [id]));
            return row ? queue(row) : null;
        },

        async listQueue(workspaceId, mailboxId) {
            const rows =
                mailboxId === null
                    ? await q.query<QueueRow>(
                          'SELECT * FROM ft_mailserver_queue WHERE workspace_id = ? ORDER BY created DESC LIMIT 200',
                          [workspaceId]
                      )
                    : await q.query<QueueRow>(
                          'SELECT * FROM ft_mailserver_queue WHERE mailbox_id = ? ORDER BY created DESC LIMIT 200',
                          [mailboxId]
                      );
            return rows.map(queue);
        },

        async requeueStuck() {
            await q.execute("UPDATE ft_mailserver_queue SET status = 'queued' WHERE status = 'sending'");
        },

        async queueCounts(mailboxId) {
            const rows = await q.query<{ status: string; total: number }>(
                'SELECT status, COUNT(*) AS total FROM ft_mailserver_queue WHERE mailbox_id = ? GROUP BY status',
                [mailboxId]
            );
            const of = (status: string): number => Number(rows.find((r) => r.status === status)?.total ?? 0);
            return { queued: of('queued') + of('sending'), deferred: of('deferred') };
        },

        async queueDepth() {
            const rows = await q.query<{ total: number }>('SELECT COUNT(*) AS total FROM ft_mailserver_queue');
            return Number(rows[0]?.total ?? 0);
        },

        async findDomainKey(host) {
            return one(await q.query<DomainKeyRow>('SELECT * FROM ft_mailserver_domain_keys WHERE host = ?', [host]));
        },

        async insertDomainKey(input) {
            await q.execute(
                `INSERT IGNORE INTO ft_mailserver_domain_keys (workspace_id, host, selector, private_key, public_key)
                 VALUES (?, ?, ?, ?, ?)`,
                [input.workspaceId, input.host, input.selector, input.privateKey, input.publicKey]
            );
        },

        async insertEvent(input) {
            await q.execute(
                `INSERT INTO ft_mailserver_events (mailbox_id, ts, kind, size, spf, dkim, dmarc, content)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [input.mailboxId, input.ts, input.kind, input.size, input.spf, input.dkim, input.dmarc, input.content]
            );
        },

        async recentEvents(mailboxId, limit) {
            const rows = await q.query<EventRow>(
                `SELECT * FROM ft_mailserver_events WHERE mailbox_id = ?
                  ORDER BY ts DESC, id DESC LIMIT ${Math.max(1, Math.floor(limit))}`,
                [mailboxId]
            );
            return rows.map((row) => ({ ...row, id: Number(row.id), ts: Number(row.ts) }));
        },

        async purgeEvents(before) {
            const res = await q.execute('DELETE FROM ft_mailserver_events WHERE ts < ?', [before]);
            return res.affectedRows;
        },

        async bumpDaily(mailboxId, day, column) {
            // `column` vient d'une union fermée de quatre noms, jamais d'une entrée.
            await q.execute(
                `INSERT INTO ft_mailserver_daily (mailbox_id, day, ${column}) VALUES (?, ?, 1)
                 ON DUPLICATE KEY UPDATE ${column} = ${column} + 1`,
                [mailboxId, day]
            );
        },

        dailySince: (mailboxId, day) =>
            q.query<DailyRow>('SELECT * FROM ft_mailserver_daily WHERE mailbox_id = ? AND day >= ? ORDER BY day', [
                mailboxId,
                day
            ]),

        async sentOn(mailboxId, day) {
            const rows = await q.query<{ sent: number }>(
                'SELECT sent FROM ft_mailserver_daily WHERE mailbox_id = ? AND day = ?',
                [mailboxId, day]
            );
            return Number(rows[0]?.sent ?? 0);
        },

        async getTls(hostname, kind, directory) {
            const row = one(
                await q.query<TlsRow>(
                    'SELECT hostname, kind, directory, sealed, cert_pem, not_after FROM ft_mailserver_tls WHERE hostname = ? AND kind = ? AND directory = ?',
                    [hostname, kind, directory]
                )
            );
            return row ? { ...row, not_after: nullable(row.not_after) } : null;
        },

        async putTls(row) {
            await q.execute(
                `INSERT INTO ft_mailserver_tls (hostname, kind, directory, sealed, cert_pem, not_after)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE sealed = VALUES(sealed), cert_pem = VALUES(cert_pem), not_after = VALUES(not_after)`,
                [row.hostname, row.kind, row.directory, row.sealed, row.cert_pem, row.not_after]
            );
        }
    };
}
