import type { Logger } from 'pino';

import { decryptCredentials } from '@/features/mail/_shared';
import { syncAccountFolders, syncOneFolder } from '@/features/mail/_sync';
import { beginAccountSync, endAccountSync, markFolderSynced, reportFolderProgress } from '@/features/mail/_syncStatus';
import { createOpenCipher, type Cipher } from '@/Services/SecureStore';
import { env } from '@/Utils/Env';

import type { LiveHub } from '@/live/hub';
import type { Database } from '@/db';
import type Encryption from './Encryption';

/**
 * Background sync loop (process singleton), the Mail equivalent of
 * {@link UptimeMonitor}. Runs with **no session and no password**, so it can
 * only ever reach "open"-tier accounts — `mail_accounts.listSyncDue` already
 * filters to those; a "guarded" account's cipher needs a live session unlock
 * and is structurally unreachable here, by design (see `Docs/SECURITY_MODEL.md`).
 * Guarded accounts sync on demand instead, during a live unlocked WS session:
 * `mail.folderList` et `mail.messageList` relèvent à l'ouverture, et le bouton
 * de relève appelle `mail.folderSync`.
 *
 * Chaque passage fait deux choses, et pas une : rapatrier les messages arrivés,
 * et réconcilier la fenêtre récente déjà en cache (drapeaux, disparus). Sans la
 * seconde, une boîte lue depuis un téléphone dérivait sans fin — voir
 * {@link syncOneFolder}.
 */

/**
 * `work`, mais abandonnée si l'échéance passe avant elle.
 *
 * La promesse sous-jacente n'est pas annulable — IMAP continuera jusqu'à ce que
 * ses propres délais mordent — mais on cesse de l'attendre, ce qui est tout
 * l'objet : la place qu'elle occupait dans la rotation est rendue. Une écriture
 * tardive de la relève abandonnée reste inoffensive, le cache s'écrivant par
 * upsert idempotent.
 */
async function withDeadline<T>(work: Promise<T>, deadline: number, message: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            work,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(message)), Math.max(0, deadline - Date.now()));
                timer.unref();
            })
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

interface SyncDeps {
    db: Database;
    crypt: Encryption;
    logger: Logger;
    /**
     * Présence en direct. Ce service écrit sans commande utilisateur, donc sans
     * socket pour diffuser : c'est le hub qu'il avertit directement. Optionnel —
     * les tests l'instancient sans lui.
     */
    live?: LiveHub;
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

    /** Codec de l'étage ouvert d'un espace, mémoïsé pour la durée du process. */
    private cipherFor(workspaceId: number): Cipher {
        let cipher = this.ciphers.get(workspaceId);
        if (!cipher) {
            cipher = createOpenCipher(this.deps.db, this.deps.crypt, workspaceId);
            this.ciphers.set(workspaceId, cipher);
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

    /**
     * Sync one account's folders + each folder's new messages. Never throws.
     *
     * Sous échéance, parce que `inFlight` protège du double traitement mais ne
     * rend jamais la main : une connexion suspendue retirait le compte de la
     * rotation pour de bon, sans erreur enregistrée ni ligne de log — sa seule
     * trace était une date de dernière relève qui vieillissait. Passé le délai,
     * la relève est abandonnée et l'échec consigné comme n'importe quel autre,
     * ce qui la fait simplement réessayer au tour suivant.
     */
    async syncOne(accountId: number): Promise<void> {
        if (this.inFlight.has(accountId)) return;
        this.inFlight.add(accountId);
        const deadline = Date.now() + env.MAIL_SYNC_ACCOUNT_TIMEOUT_SECONDS * 1000;
        try {
            const row = await this.deps.db.mailAccounts.findByIdUnscoped(accountId);
            if (!row || row.enabled !== 1 || row.security_tier !== 'open') return;
            const cipher = this.cipherFor(row.workspace_id);
            try {
                const credentials = await decryptCredentials(cipher, row.credentials_enc);
                const folders = await withDeadline(
                    syncAccountFolders(this.deps.db, cipher, row, credentials),
                    deadline,
                    'Relève interrompue : la liste des dossiers n’a pas répondu à temps'
                );
                beginAccountSync(accountId, folders.length);
                let moved = 0;
                try {
                    for (const folder of folders) {
                        const outcome = await withDeadline(
                            syncOneFolder(this.deps.db, cipher, row, credentials, folder, (done, estimatedTotal) =>
                                reportFolderProgress(accountId, done / estimatedTotal)
                            ),
                            deadline,
                            `Relève interrompue : le dossier « ${folder.imap_path} » n'a pas répondu à temps`
                        );
                        moved += outcome.newCount + outcome.changedCount + outcome.removedCount;
                        markFolderSynced(accountId);
                    }
                } finally {
                    endAccountSync(accountId);
                }
                await this.deps.db.mailAccounts.recordSync(row.id, Math.floor(Date.now() / 1000), null);
                this.deps.logger.debug({ accountId, moved }, 'Mail account synced');
                // Une synchronisation a pu faire entrer des messages, en corriger
                // les drapeaux ou en retirer : c'est le seul moment où le contenu
                // bouge sans qu'aucun membre n'ait rien demandé.
                //
                // Sous condition, parce que c'est la seule source de
                // rafraîchissement de la vue ouverte : diffuser à chaque relève
                // ferait resolliciter la liste de tout client connecté toutes les
                // dix minutes par compte, pour rien. Le débit de l'événement doit
                // rester celui des messages, pas celui de l'horloge.
                if (moved > 0) this.deps.live?.changed(row.workspace_id, ['mail'], null);
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
