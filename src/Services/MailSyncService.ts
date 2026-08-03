import type { Logger } from 'pino';

import { decryptCredentials } from '@/features/mail/_shared';
import { syncAccountFolders, syncOneFolder } from '@/features/mail/_sync';
import { beginAccountSync, endAccountSync, markFolderSynced, reportFolderProgress } from '@/features/mail/_syncStatus';
import { createOpenCipher, type Cipher } from '@/Services/SecureStore';
import { env } from '@/Utils/Env';

import type { Database } from '@/db';
import type Encryption from './Encryption';

/**
 * Background sync loop (process singleton), the Mail equivalent of
 * {@link UptimeMonitor}. Runs with **no session and no password**, so it can
 * only ever reach "open"-tier accounts — `mail_accounts.listSyncDue` already
 * filters to those; a "guarded" account's cipher needs a live session unlock
 * and is structurally unreachable here, by design (see `Docs/SECURITY_MODEL.md`).
 * Guarded accounts sync on demand instead, via `mail.folderSync` during a live,
 * unlocked WS session.
 */

interface SyncDeps {
    db: Database;
    crypt: Encryption;
    logger: Logger;
}

export class MailSyncService {
    private timer: ReturnType<typeof setInterval> | null = null;
    private ticking = false;
    private readonly ciphers = new Map<number, Cipher>();
    private readonly inFlight = new Set<number>();

    constructor(private readonly deps: SyncDeps) {}

    start(): void {
        if (this.timer) return;
        this.timer = setInterval(() => void this.tick(), env.MAIL_SYNC_TICK_SECONDS * 1000);
        this.timer.unref();
        void this.tick();
        this.deps.logger.info({ tickSeconds: env.MAIL_SYNC_TICK_SECONDS }, 'Mail sync service started');
    }

    stop(): void {
        if (!this.timer) return;
        clearInterval(this.timer);
        this.timer = null;
    }

    private cipherFor(userId: number): Cipher {
        let cipher = this.ciphers.get(userId);
        if (!cipher) {
            cipher = createOpenCipher(this.deps.db, this.deps.crypt, userId);
            this.ciphers.set(userId, cipher);
        }
        return cipher;
    }

    private async tick(): Promise<void> {
        if (this.ticking) return;
        this.ticking = true;
        try {
            const now = Math.floor(Date.now() / 1000);
            const due = await this.deps.db.mailAccounts.listSyncDue(now, env.MAIL_SYNC_CONCURRENCY * 4);
            for (let i = 0; i < due.length; i += env.MAIL_SYNC_CONCURRENCY) {
                await Promise.all(due.slice(i, i + env.MAIL_SYNC_CONCURRENCY).map((row) => this.syncOne(row.id)));
            }
        } catch (e) {
            this.deps.logger.error({ err: e instanceof Error ? e.message : String(e) }, 'Mail sync tick failed');
        } finally {
            this.ticking = false;
        }
    }

    /** Sync one account's folders + each folder's new messages. Never throws. */
    async syncOne(accountId: number): Promise<void> {
        if (this.inFlight.has(accountId)) return;
        this.inFlight.add(accountId);
        try {
            const row = await this.deps.db.mailAccounts.findByIdUnscoped(accountId);
            if (!row || row.enabled !== 1 || row.security_tier !== 'open') return;
            const cipher = this.cipherFor(row.user_id);
            try {
                const credentials = await decryptCredentials(cipher, row.credentials_enc);
                const folders = await syncAccountFolders(this.deps.db, cipher, row, credentials);
                beginAccountSync(accountId, folders.length);
                try {
                    for (const folder of folders) {
                        await syncOneFolder(this.deps.db, cipher, row, credentials, folder, (done, estimatedTotal) =>
                            reportFolderProgress(accountId, done / estimatedTotal)
                        );
                        markFolderSynced(accountId);
                    }
                } finally {
                    endAccountSync(accountId);
                }
                await this.deps.db.mailAccounts.recordSync(row.id, Math.floor(Date.now() / 1000), null);
            } catch (e) {
                const message = e instanceof Error ? e.message : String(e);
                this.deps.logger.warn({ accountId, err: message }, 'Mail account sync failed');
                await this.deps.db.mailAccounts.recordSync(
                    row.id,
                    Math.floor(Date.now() / 1000),
                    await cipher.encrypt(message)
                );
            }
        } finally {
            this.inFlight.delete(accountId);
        }
    }
}
