import type { FeatureService, FeatureServiceDeps } from '@deveye/types/sdk/server';

import * as mailClient from './client';
import { MAIL_SYNC_PROGRESS_EVENT, type MailSyncProgress } from '../contracts/domain';
import { env } from './env';
import type { MailRepo } from './repo';
import { syncAccountFolders, syncOneFolder, type SyncClient } from './sync';
import {
    beginAccountSync,
    endAccountSync,
    getAccountSyncStatus,
    markFolderSynced,
    reportFolderProgress
} from './syncStatus';
import { classifyMailError, decryptCredentials, persistRefreshedToken } from './_shared';

/**
 * Background sync loop (process singleton). Runs with no session and no
 * password, so it can only ever reach "open"-tier accounts: a "guarded"
 * account's cipher needs a live session unlock and is structurally unreachable
 * here (`Docs/SECURITY_MODEL.md`). Guarded accounts sync on demand instead,
 * during an unlocked WS session.
 *
 * Chaque passage fait deux choses : rapatrier les messages arrivés, et
 * réconcilier la fenêtre récente déjà en cache (voir {@link syncOneFolder}),
 * sans quoi une boîte lue depuis un autre client dérive sans fin.
 *
 * La relève tourne au domicile du compte, et une seule fois : `listSyncDue` lit
 * les comptes, pas ce qu'on voit d'eux. La diffusion, elle, traverse la
 * projection, l'hôte rejouant `deps.live.changed` dans chaque espace relié par
 * `item_shares` (`Docs/SHARING.md` §8).
 */

/**
 * `work`, mais abandonnée si l'échéance passe avant elle. La promesse
 * sous-jacente n'est pas annulable, on cesse seulement de l'attendre : la place
 * qu'elle occupait dans la rotation est rendue, et une écriture tardive reste
 * inoffensive, le cache s'écrivant par upsert idempotent.
 */
/** Cadence des trames d'avancement : `reportFolderProgress` tombe à chaque message. */
const PUBLISH_EVERY_MS = 1000;

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

/**
 * La couture de test du service : un client IMAP sans réseau, qui décide de ce
 * que la boîte répond, et une échéance courte. Rien d'autre n'est simulable, le
 * reste du chemin (cache, état du compte, diffusion) devant tourner tel quel.
 */
export interface MailSyncSeam {
    mailClient?: SyncClient;
    accountTimeoutMs?: number;
}

export class MailSync {
    private readonly ticker: FeatureService;
    private readonly client: SyncClient;
    private readonly accountTimeoutMs: number;
    private readonly inFlight = new Set<number>();
    private first: Promise<void> = Promise.resolve();

    constructor(
        private readonly deps: FeatureServiceDeps<MailRepo>,
        seam: MailSyncSeam = {}
    ) {
        this.client = seam.mailClient ?? mailClient;
        this.accountTimeoutMs = seam.accountTimeoutMs ?? env.MAIL_SYNC_ACCOUNT_TIMEOUT_SECONDS * 1000;
        this.ticker = deps.createTicker({ intervalMs: env.MAIL_SYNC_TICK_SECONDS * 1000, tick: () => this.tick() });
    }

    start(): void {
        this.ticker.start();
        // Un premier tour tout de suite : une boîte due n'attend pas la cadence.
        this.first = this.tick();
        this.deps.logger.info({ tickSeconds: env.MAIL_SYNC_TICK_SECONDS }, 'Mail sync service started');
    }

    async stop(): Promise<void> {
        await Promise.all([this.ticker.stop(), this.first]);
    }

    private async tick(): Promise<void> {
        try {
            const now = Math.floor(Date.now() / 1000);
            const due = await this.deps.repo.accounts.listSyncDue(
                now,
                env.MAIL_SYNC_CONCURRENCY * 4,
                this.deps.pauses.paused('accounts').map(Number)
            );
            for (let i = 0; i < due.length; i += env.MAIL_SYNC_CONCURRENCY) {
                await Promise.all(due.slice(i, i + env.MAIL_SYNC_CONCURRENCY).map((row) => this.syncOne(row.id)));
            }
        } catch (e) {
            this.deps.logger.error({ err: e instanceof Error ? e.message : String(e) }, 'Mail sync tick failed');
        }
    }

    /**
     * Sync one account's folders + each folder's new messages. Never throws.
     *
     * Sous échéance, parce que `inFlight` protège du double traitement mais ne
     * rend jamais la main : une connexion suspendue retirerait le compte de la
     * rotation pour de bon, sans erreur enregistrée. Passé le délai, l'échec est
     * consigné comme un autre et la relève réessaie au tour suivant.
     */
    async syncOne(accountId: number): Promise<void> {
        if (this.inFlight.has(accountId)) return;
        this.inFlight.add(accountId);
        const deadline = Date.now() + this.accountTimeoutMs;
        try {
            const row = await this.deps.repo.accounts.findByIdUnscoped(accountId);
            if (!row || row.enabled !== 1 || row.security_tier !== 'open') return;
            if (this.deps.pauses.isPaused('accounts', String(row.id))) return;
            const cipher = this.deps.cipherFor(row.workspace_id);
            try {
                const credentials = await decryptCredentials(cipher, row.credentials_enc);
                // Toute la passe sur une seule connexion : la liste des dossiers
                // puis chacun d'eux. La poignée de main coûte plus que la relève,
                // et une boîte fournie a des dizaines de dossiers.
                // L'avancement part en trames : elles animent la barre, et
                // `mail.accountList` fait foi. Sans elles, un écran ouvert n'a
                // d'autre recours que de redemander la liste en boucle.
                let lastPublish = 0;
                const publish = (force: boolean): void => {
                    const at = Date.now();
                    if (!force && at - lastPublish < PUBLISH_EVERY_MS) return;
                    lastPublish = at;
                    const { syncing, progress } = getAccountSyncStatus(accountId);
                    const frame: MailSyncProgress = { accountId, syncing, progress };
                    this.deps.live.publish(row.workspace_id, MAIL_SYNC_PROGRESS_EVENT, frame);
                };

                const moved = await this.client.withSession(
                    credentials,
                    persistRefreshedToken(this.deps.repo, row.id, credentials, cipher),
                    async (session) => {
                        const folders = await withDeadline(
                            syncAccountFolders(session, this.deps.repo, cipher, row.id),
                            deadline,
                            'Relève interrompue : la liste des dossiers n’a pas répondu à temps'
                        );
                        beginAccountSync(accountId, folders.length);
                        publish(true);
                        let count = 0;
                        try {
                            for (const folder of folders) {
                                const outcome = await withDeadline(
                                    syncOneFolder(session, this.deps.repo, cipher, folder, (done, estimatedTotal) => {
                                        reportFolderProgress(accountId, done / estimatedTotal);
                                        publish(false);
                                    }),
                                    deadline,
                                    `Relève interrompue : le dossier « ${folder.imap_path} » n'a pas répondu à temps`
                                );
                                count += outcome.newCount + outcome.changedCount + outcome.removedCount;
                                markFolderSynced(accountId);
                                publish(false);
                            }
                        } finally {
                            // Hors cadence : la trame terminale est la seule que
                            // personne ne peut déduire, et la barre reste posée
                            // jusqu'à la prochaine relecture si elle manque.
                            endAccountSync(accountId);
                            publish(true);
                        }
                        return count;
                    }
                );
                await this.deps.repo.accounts.recordSync(row.id, Math.floor(Date.now() / 1000), null, 'ok');
                this.deps.logger.debug({ accountId, moved }, 'Mail account synced');
                // Sous condition, parce que c'est la seule source de
                // rafraîchissement de la vue ouverte : diffuser à chaque relève
                // resolliciterait tout client connecté pour rien. Le débit de
                // l'événement doit rester celui des messages, pas celui de
                // l'horloge ; un retour au vert vaut aussi d'être annoncé.
                if (moved > 0 || row.last_sync_status !== 'ok') {
                    this.deps.live.changed(row.workspace_id);
                }
            } catch (e) {
                const message = e instanceof Error ? e.message : String(e);
                const status = classifyMailError(e);
                this.deps.logger.warn({ accountId, status, err: e }, 'Mail account sync failed');
                await this.deps.repo.accounts.recordSync(
                    row.id,
                    Math.floor(Date.now() / 1000),
                    await cipher.encrypt(message),
                    status
                );
                // Une boîte qui tombe en panne doit se signaler tout de suite :
                // c'est le seul moment où quelqu'un peut l'apprendre sans avoir
                // lui-même buté dessus.
                if (row.last_sync_status !== status) this.deps.live.changed(row.workspace_id);
            }
        } finally {
            this.inFlight.delete(accountId);
        }
    }
}
