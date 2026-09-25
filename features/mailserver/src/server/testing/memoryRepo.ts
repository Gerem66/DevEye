import type {
    BlobRow,
    CredentialRow,
    DailyRow,
    DomainKeyRow,
    EventRow,
    FolderRow,
    MailboxRow,
    MailserverRepo,
    MessageRow,
    QueueRow,
    TlsRow
} from '../repo';

/** Le jumeau en mémoire du dépôt SQL, pour les tests du moteur et des commandes. Pas de projections entre espaces. */
export interface MemoryRepo extends MailserverRepo {
    mailboxes: MailboxRow[];
    folders: FolderRow[];
    messages: (MessageRow & { meta: string })[];
    blobs: BlobRow[];
    queue: QueueRow[];
    events: EventRow[];
    daily: DailyRow[];
    credentials: CredentialRow[];
}

export function memoryRepo(): MemoryRepo {
    const mailboxes: MailboxRow[] = [];
    const uidValidity = new Map<number, number>();
    const credentials: CredentialRow[] = [];
    const folders: FolderRow[] = [];
    const blobs: BlobRow[] = [];
    const messages: (MessageRow & { meta: string })[] = [];
    const queue: QueueRow[] = [];
    const domainKeys: DomainKeyRow[] = [];
    const events: EventRow[] = [];
    const daily: DailyRow[] = [];
    const tls: TlsRow[] = [];
    let ids = 0;
    const nextId = (): number => (ids += 1);
    const copy = <T>(row: T | undefined): T | null => (row ? { ...row } : null);
    const mailboxOf = (id: number): MailboxRow | undefined => mailboxes.find((m) => m.id === id);

    return {
        mailboxes,
        folders,
        messages,
        blobs,
        queue,
        events,
        daily,
        credentials,

        listVisible: (ws) =>
            Promise.resolve(
                mailboxes
                    .filter((m) => m.workspace_id === ws)
                    .sort((a, b) => (a.address < b.address ? -1 : 1))
                    .map((m) => ({ ...m }))
            ),
        findVisible: (id, ws) => Promise.resolve(copy(mailboxes.find((m) => m.id === id && m.workspace_id === ws))),
        find: (id, ws) => Promise.resolve(copy(mailboxes.find((m) => m.id === id && m.workspace_id === ws))),
        findById: (id) => Promise.resolve(copy(mailboxOf(id))),
        findByAddress: (address) => Promise.resolve(copy(mailboxes.find((m) => m.address === address))),
        countInWorkspaces: (workspaceIds) =>
            Promise.resolve(mailboxes.filter((m) => workspaceIds.includes(m.workspace_id)).length),
        listInWorkspaces: (workspaceIds) =>
            Promise.resolve(
                mailboxes
                    .filter((m) => workspaceIds.includes(m.workspace_id))
                    .sort((a, b) => a.created - b.created || a.id - b.id)
                    .map((m) => ({ id: String(m.id), workspaceId: m.workspace_id }))
            ),
        createMailbox(input) {
            const id = nextId();
            mailboxes.push({
                id,
                workspace_id: input.workspaceId,
                domain_id: input.domainId,
                local_part: input.localPart,
                address: input.address,
                enabled: 1,
                password_hash: input.passwordHash,
                password_set_at: input.now,
                quota_bytes: input.quotaBytes,
                used_bytes: 0,
                message_count: 0,
                outbound_daily_limit: input.outboundDailyLimit,
                blob_key: input.blobKey,
                banner_dismissed: 0,
                last_delivery_at: null,
                last_login_at: null,
                content: input.content,
                created: input.now
            });
            uidValidity.set(id, 1);
            return Promise.resolve(id);
        },
        updateMailbox(id, patch) {
            const row = mailboxOf(id);
            if (row) {
                row.enabled = patch.enabled ? 1 : 0;
                row.quota_bytes = patch.quotaBytes;
                row.outbound_daily_limit = patch.outboundDailyLimit;
                row.content = patch.content;
            }
            return Promise.resolve();
        },
        setBanner(id, dismissed) {
            const row = mailboxOf(id);
            if (row) row.banner_dismissed = dismissed ? 1 : 0;
            return Promise.resolve();
        },
        setPassword(id, hash, now) {
            const row = mailboxOf(id);
            if (row) {
                row.password_hash = hash;
                row.password_set_at = now;
            }
            return Promise.resolve();
        },
        deleteMailbox(id) {
            const drop = <T>(list: T[], keep: (row: T) => boolean): void => {
                list.splice(0, list.length, ...list.filter(keep));
            };
            drop(mailboxes, (m) => m.id !== id);
            drop(credentials, (c) => c.mailbox_id !== id);
            drop(folders, (f) => f.mailbox_id !== id);
            drop(messages, (m) => m.mailbox_id !== id);
            drop(blobs, (b) => b.mailbox_id !== id);
            drop(queue, (q) => q.mailbox_id !== id);
            drop(events, (e) => e.mailbox_id !== id);
            drop(daily, (d) => d.mailbox_id !== id);
            return Promise.resolve();
        },
        countByDomain(ws) {
            const out = new Map<number, number>();
            for (const m of mailboxes) {
                if (m.workspace_id === ws) out.set(m.domain_id, (out.get(m.domain_id) ?? 0) + 1);
            }
            return Promise.resolve(out);
        },
        touchLogin(id, now) {
            const row = mailboxOf(id);
            if (row) row.last_login_at = now;
            return Promise.resolve();
        },
        touchDelivery(id, now) {
            const row = mailboxOf(id);
            if (row) row.last_delivery_at = now;
            return Promise.resolve();
        },
        adjustUsage(id, bytes, count) {
            const row = mailboxOf(id);
            if (row) {
                row.used_bytes = Math.max(0, row.used_bytes + bytes);
                row.message_count = Math.max(0, row.message_count + count);
            }
            return Promise.resolve();
        },
        nextUidValidity(id) {
            const value = uidValidity.get(id) ?? 1;
            uidValidity.set(id, value + 1);
            return Promise.resolve(value);
        },

        listCredentials: (mailboxId) =>
            Promise.resolve(credentials.filter((c) => c.mailbox_id === mailboxId).map((c) => ({ ...c }))),
        createCredential(input) {
            const id = nextId();
            credentials.push({
                id,
                mailbox_id: input.mailboxId,
                label: input.label,
                secret_hash: input.secretHash,
                origin: input.origin,
                save_sent: input.saveSent ? 1 : 0,
                created: input.now,
                created_by: input.createdBy,
                last_used_at: null
            });
            return Promise.resolve(id);
        },
        deleteCredential(id, mailboxId) {
            const at = credentials.findIndex((c) => c.id === id && c.mailbox_id === mailboxId);
            if (at !== -1) credentials.splice(at, 1);
            return Promise.resolve(at !== -1);
        },
        touchCredential(id, now) {
            const row = credentials.find((c) => c.id === id);
            if (row) row.last_used_at = now;
            return Promise.resolve();
        },

        listFolders: (mailboxId) =>
            Promise.resolve(
                folders
                    .filter((f) => f.mailbox_id === mailboxId)
                    .sort((a, b) => (a.path < b.path ? -1 : 1))
                    .map((f) => ({ ...f }))
            ),
        findFolder: (mailboxId, path) =>
            Promise.resolve(copy(folders.find((f) => f.mailbox_id === mailboxId && f.path === path))),
        findFolderById: (id) => Promise.resolve(copy(folders.find((f) => f.id === id))),
        createFolder(input) {
            const id = nextId();
            folders.push({
                id,
                mailbox_id: input.mailboxId,
                path: input.path,
                special_use: input.specialUse,
                uid_validity: input.uidValidity,
                uid_next: 1,
                subscribed: 1
            });
            return Promise.resolve(id);
        },
        renameFolder(id, path) {
            const row = folders.find((f) => f.id === id);
            if (row) row.path = path;
            return Promise.resolve();
        },
        deleteFolder(id) {
            folders.splice(0, folders.length, ...folders.filter((f) => f.id !== id));
            messages.splice(0, messages.length, ...messages.filter((m) => m.folder_id !== id));
            return Promise.resolve();
        },
        setSubscribed(id, subscribed) {
            const row = folders.find((f) => f.id === id);
            if (row) row.subscribed = subscribed ? 1 : 0;
            return Promise.resolve();
        },
        allocateUid(folderId) {
            const row = folders.find((f) => f.id === folderId);
            if (!row) return Promise.reject(new Error('Dossier inconnu'));
            row.uid_next += 1;
            return Promise.resolve(row.uid_next - 1);
        },

        createBlob(input) {
            const id = nextId();
            blobs.push({ id, mailbox_id: input.mailboxId, ref: input.ref, size: input.size, refs: 1 });
            return Promise.resolve(id);
        },
        findBlob: (id) => Promise.resolve(copy(blobs.find((b) => b.id === id))),
        refBlob(id, delta) {
            const row = blobs.find((b) => b.id === id);
            if (!row) return Promise.resolve(0);
            row.refs += delta;
            return Promise.resolve(row.refs);
        },
        deleteBlob(id) {
            blobs.splice(0, blobs.length, ...blobs.filter((b) => b.id !== id));
            return Promise.resolve();
        },

        insertMessage(input) {
            const id = nextId();
            messages.push({
                id,
                mailbox_id: input.mailboxId,
                folder_id: input.folderId,
                uid: input.uid,
                flags: input.flags,
                keywords: input.keywords,
                internal_date: input.internalDate,
                size: input.size,
                blob_id: input.blobId,
                meta: input.meta
            });
            return Promise.resolve(id);
        },
        listMessages: (folderId) =>
            Promise.resolve(
                messages
                    .filter((m) => m.folder_id === folderId)
                    .sort((a, b) => a.uid - b.uid)
                    .map(({ meta: _meta, ...row }) => row)
            ),
        findMessage(folderId, uid) {
            const hit = messages.find((m) => m.folder_id === folderId && m.uid === uid);
            if (!hit) return Promise.resolve(null);
            const { meta: _meta, ...row } = hit;
            return Promise.resolve(row);
        },
        messageMeta: (id) => Promise.resolve(messages.find((m) => m.id === id)?.meta ?? null),
        setFlags(id, flags, keywords) {
            const row = messages.find((m) => m.id === id);
            if (row) {
                row.flags = flags;
                row.keywords = keywords;
            }
            return Promise.resolve();
        },
        deleteMessage(id) {
            messages.splice(0, messages.length, ...messages.filter((m) => m.id !== id));
            return Promise.resolve();
        },

        enqueue(input) {
            const id = nextId();
            queue.push({
                id,
                workspace_id: input.workspaceId,
                mailbox_id: input.mailboxId,
                blob_id: input.blobId,
                status: 'queued',
                attempts: 0,
                next_attempt_at: input.now,
                created: input.now,
                content: input.content
            });
            return Promise.resolve(id);
        },
        dueQueue: (now, limit) =>
            Promise.resolve(
                queue
                    .filter((q) => q.status !== 'sending' && q.next_attempt_at <= now)
                    .sort((a, b) => a.next_attempt_at - b.next_attempt_at)
                    .slice(0, limit)
                    .map((q) => ({ ...q }))
            ),
        claimQueue(id) {
            const row = queue.find((q) => q.id === id && q.status !== 'sending');
            if (row) row.status = 'sending';
            return Promise.resolve(row !== undefined);
        },
        deferQueue(id, attempts, nextAttemptAt, content) {
            const row = queue.find((q) => q.id === id);
            if (row) Object.assign(row, { status: 'deferred', attempts, next_attempt_at: nextAttemptAt, content });
            return Promise.resolve();
        },
        retryQueueNow(id, now) {
            const row = queue.find((q) => q.id === id && q.status !== 'sending');
            if (row) Object.assign(row, { status: 'queued', next_attempt_at: now });
            return Promise.resolve();
        },
        removeQueue(id) {
            queue.splice(0, queue.length, ...queue.filter((q) => q.id !== id));
            return Promise.resolve();
        },
        findQueue: (id) => Promise.resolve(copy(queue.find((q) => q.id === id))),
        listQueue: (ws, mailboxId) =>
            Promise.resolve(
                queue
                    .filter((q) => (mailboxId === null ? q.workspace_id === ws : q.mailbox_id === mailboxId))
                    .map((q) => ({ ...q }))
            ),
        requeueStuck() {
            for (const row of queue) if (row.status === 'sending') row.status = 'queued';
            return Promise.resolve();
        },
        queueCounts(mailboxId) {
            const own = queue.filter((q) => q.mailbox_id === mailboxId);
            return Promise.resolve({
                queued: own.filter((q) => q.status !== 'deferred').length,
                deferred: own.filter((q) => q.status === 'deferred').length
            });
        },
        queueDepth: () => Promise.resolve(queue.length),

        findDomainKey: (host) => Promise.resolve(copy(domainKeys.find((k) => k.host === host))),
        insertDomainKey(input) {
            if (!domainKeys.some((k) => k.host === input.host)) {
                domainKeys.push({
                    id: nextId(),
                    workspace_id: input.workspaceId,
                    host: input.host,
                    selector: input.selector,
                    private_key: input.privateKey,
                    public_key: input.publicKey
                });
            }
            return Promise.resolve();
        },

        insertEvent(input) {
            events.push({
                id: nextId(),
                mailbox_id: input.mailboxId,
                ts: input.ts,
                kind: input.kind,
                size: input.size,
                spf: input.spf,
                dkim: input.dkim,
                dmarc: input.dmarc,
                content: input.content
            });
            return Promise.resolve();
        },
        recentEvents: (mailboxId, limit) =>
            Promise.resolve(
                events
                    .filter((e) => e.mailbox_id === mailboxId)
                    .sort((a, b) => b.ts - a.ts || b.id - a.id)
                    .slice(0, limit)
                    .map((e) => ({ ...e }))
            ),
        purgeEvents(before) {
            const kept = events.filter((e) => e.ts >= before);
            const removed = events.length - kept.length;
            events.splice(0, events.length, ...kept);
            return Promise.resolve(removed);
        },
        bumpDaily(mailboxId, day, column) {
            let row = daily.find((d) => d.mailbox_id === mailboxId && d.day === day);
            if (!row) {
                row = { mailbox_id: mailboxId, day, received: 0, sent: 0, rejected: 0, bounced: 0 };
                daily.push(row);
            }
            row[column] += 1;
            return Promise.resolve();
        },
        dailySince: (mailboxId, day) =>
            Promise.resolve(
                daily
                    .filter((d) => d.mailbox_id === mailboxId && d.day >= day)
                    .sort((a, b) => (a.day < b.day ? -1 : 1))
                    .map((d) => ({ ...d }))
            ),
        sentOn: (mailboxId, day) =>
            Promise.resolve(daily.find((d) => d.mailbox_id === mailboxId && d.day === day)?.sent ?? 0),

        getTls: (hostname, kind, directory) =>
            Promise.resolve(
                copy(tls.find((t) => t.hostname === hostname && t.kind === kind && t.directory === directory))
            ),
        putTls(row) {
            const at = tls.findIndex(
                (t) => t.hostname === row.hostname && t.kind === row.kind && t.directory === row.directory
            );
            if (at === -1) tls.push({ ...row });
            else tls[at] = { ...row };
            return Promise.resolve();
        }
    };
}
