import type { DatabaseProbe, DatabaseRow } from '../contracts/domain';
import type { FeatureService, FeatureServiceDeps } from '@deveye/types/sdk/server';

import { explainError, openSession, type EngineTarget, type Session } from './engine';
import { buildNotice } from './notice';
import type { DatabaseRepo } from './repo';
import { isFiring, renderMessage, runConditions } from './rules';
import { readJson, type StoredAccess, type StoredAlert, type StoredDatabase } from './_shared';

/**
 * Le relevé périodique des bases de données, et l'évaluation de leurs alertes.
 *
 * **Éteint par défaut, base par base.** C'est la différence de fond avec
 * `UptimeMonitor`, qui surveille tout ce qu'on lui confie : ici, ouvrir la
 * feature ne joint aucun serveur, et seule une base dont `monitor_enabled` vaut
 * 1 entre dans cette boucle. Une base au repos ne coûte rien et ne réveille
 * personne — ce qui est le comportement qu'on attend d'un inventaire.
 *
 * Corollaire à connaître : **une alerte n'est évaluée que si le relevé est
 * actif** sur sa base. Une alerte définie sur une base au repos est inerte, et
 * l'interface le dit plutôt que de laisser croire à une surveillance qui
 * n'existe pas.
 *
 * ## Les canaux de notification sont les siens
 *
 * Ils ne l'ont pas toujours été : ce service appelait `UptimeMonitor.resolveChannels`,
 * au motif que c'étaient « les mêmes canaux pour les mêmes personnes, et en
 * tenir deux jeux à jour serait une source d'erreur de plus ». C'est mot pour
 * mot le raisonnement que Sentinelle avait suivi avant la migration 075, et il
 * a produit le même effet : un seuil SQL franchi arrivait sur le salon désigné
 * pour la disponibilité, sans qu'on puisse l'éteindre sans éteindre Uptime.
 *
 * Depuis la migration 085, la ligne `database` de `notification_settings` est la
 * sienne — reprise à l'identique de celle d'Uptime, pour que personne ne perde
 * au redémarrage une alerte qu'il recevait la veille. La dépendance à
 * `UptimeMonitor` a disparu avec sa cause. Depuis le rapatriement en module,
 * l'envoi passe par la façade `notify` du SDK (`deps.deveyeFor(ws).notify.send`,
 * la route de LA base par `itemId`), et le service ne voit plus ni les canaux
 * ni leur résolution.
 *
 * ## Notifier aux transitions, jamais à chaque relevé
 *
 * `database_alerts.firing` porte l'état courant. Une alerte franchie qui le
 * reste ne renotifie pas : sans cela, une base qui dépasse son seuil pendant la
 * nuit enverrait un message toutes les cinq minutes, et le lendemain personne ne
 * lirait plus aucune alerte.
 *
 * Tourne **sans session ni mot de passe** : tout ce qu'il lit de chiffré passe
 * par le codec ouvert de l'espace (`deps.cipherFor`, mémoïsé par le SDK), et
 * la boucle est un ticker du SDK (`deps.createTicker`, le patron des services
 * natifs : setInterval + garde de réentrance + unref).
 */

/** Cadence de l'ordonnanceur. La cadence *par base* est sa propre colonne. */
const TICK_SECONDS = 30;

/** Bases relevées par tour : borne la rafale de connexions sortantes. */
const BATCH = 4;

/**
 * La couture de test du service : l'ouverture de session, injectable.
 *
 * Le vrai `openSession` d'`engine.ts` par défaut ; un test en simule une, sans
 * réseau, et décide de ce que la base répond (inventaire, conditions, panne).
 * Rien d'autre n'est simulable ici, et c'est voulu : le reste du chemin
 * (écritures, transitions, notifications) est précisément ce qu'on veut voir
 * tourner tel quel.
 */
export interface DatabaseEngine {
    openSession(target: EngineTarget): Promise<Session>;
}

export class DatabaseMonitor {
    /** La boucle du relevé : un ticker du SDK. */
    private readonly ticker: FeatureService;
    /** Une base à la fois : deux relevés simultanés ouvriraient deux tunnels. */
    private readonly inFlight = new Map<number, Promise<DatabaseProbe>>();

    constructor(
        private readonly deps: FeatureServiceDeps<DatabaseRepo>,
        private readonly engine: DatabaseEngine = { openSession }
    ) {
        this.ticker = deps.createTicker({ intervalMs: TICK_SECONDS * 1000, tick: () => this.tick() });
    }

    start(): void {
        this.ticker.start();
        this.deps.logger.info({ tickSeconds: TICK_SECONDS }, 'Database monitor started');
    }

    stop(): void {
        this.ticker.stop();
    }

    private async tick(): Promise<void> {
        try {
            const now = Math.floor(Date.now() / 1000);
            const due = await this.deps.repo.listDue(now, BATCH);
            await Promise.all(due.map((row) => this.checkNow(row.id, row.workspace_id)));
        } catch (e) {
            this.deps.logger.error({ err: e }, 'Database monitor: tick failed');
        }
    }

    /**
     * Relève une base maintenant, alertes comprises.
     *
     * **Le même chemin que l'ordonnanceur**, appelé aussi par `database.inspect`
     * : c'est ce qui garantit qu'un relevé manuel donne exactement le même
     * résultat qu'un relevé automatique, alertes et notifications incluses.
     *
     * Ne lève jamais : un serveur injoignable est une réponse, pas une erreur.
     */
    checkNow(databaseId: number, workspaceId: number): Promise<DatabaseProbe> {
        const running = this.inFlight.get(databaseId);
        if (running) return running;
        const task = this.runCheck(databaseId, workspaceId).finally(() => this.inFlight.delete(databaseId));
        this.inFlight.set(databaseId, task);
        return task;
    }

    /** La cible de connexion d'une ligne, secrets déchiffrés. Jamais rendue au client. */
    async targetOf(row: DatabaseRow, workspaceId: number): Promise<EngineTarget> {
        const cipher = this.deps.cipherFor(workspaceId);
        const body = await readJson<StoredDatabase>(cipher, row.content);
        if (!body) throw new Error('Les réglages de cette base sont illisibles.');
        const access = (await readJson<StoredAccess>(cipher, row.access_content)) ?? {
            kind: 'direct' as const,
            host: '',
            port: null,
            username: '',
            auth: 'password' as const
        };
        return {
            engine: row.engine === 'postgres' ? 'postgres' : 'mysql',
            host: body.host,
            port: body.port,
            database: body.database,
            username: body.username,
            password: row.secret_enc ? await cipher.tryDecrypt(row.secret_enc) : null,
            access: {
                ...access,
                secret: row.access_secret_enc ? await cipher.tryDecrypt(row.access_secret_enc) : null
            }
        };
    }

    private async runCheck(databaseId: number, workspaceId: number): Promise<DatabaseProbe> {
        const started = Date.now();
        const row = await this.deps.repo.find(databaseId, workspaceId);
        if (!row) return { ok: false, serverVersion: null, elapsedMs: 0, error: 'Base introuvable.' };

        const cipher = this.deps.cipherFor(workspaceId);
        let session: Session | null = null;
        try {
            session = await this.engine.openSession(await this.targetOf(row, workspaceId));
            const inventory = await session.inventory();
            await this.deps.repo.recordCheck(databaseId, {
                at: Math.floor(Date.now() / 1000),
                elapsedMs: Date.now() - started,
                status: 'up',
                error: null,
                serverVersion: inventory.serverVersion.slice(0, 255),
                sizeBytes: inventory.sizeBytes,
                tableCount: inventory.tableCount
            });
            await this.evaluateAlerts(row, session);
            this.deps.live.changed(workspaceId);
            return {
                ok: true,
                serverVersion: inventory.serverVersion,
                elapsedMs: Date.now() - started,
                error: null
            };
        } catch (e) {
            const message = explainError(e);
            // Le message brut part dans les journaux, la phrase claire à
            // l'écran : l'un sert au diagnostic, l'autre à la correction.
            this.deps.logger.warn(
                { databaseId, err: e instanceof Error ? e.message : String(e) },
                'Database check failed'
            );
            await this.deps.repo.recordCheck(databaseId, {
                at: Math.floor(Date.now() / 1000),
                // Le temps d'un échec compte autant que celui d'un succès : un
                // relevé qui met douze secondes à tomber dit qu'on a attendu un
                // délai d'attente, pas qu'on s'est fait refuser tout de suite.
                elapsedMs: Date.now() - started,
                status: 'down',
                error: await cipher.encrypt(message),
                // La version et la taille connues sont **conservées** : elles
                // décrivent la dernière fois où l'on a pu regarder, ce qui vaut
                // mieux qu'un écran vide pendant une coupure.
                serverVersion: row.server_version,
                sizeBytes: row.size_bytes,
                tableCount: row.table_count
            });
            this.deps.live.changed(workspaceId);
            return { ok: false, serverVersion: null, elapsedMs: Date.now() - started, error: message };
        } finally {
            if (session) {
                try {
                    await session.close();
                } catch {
                    /* la fermeture d'une session déjà morte n'a rien à dire */
                }
            }
        }
    }

    /** Évalue les alertes actives, et notifie aux transitions seulement. */
    private async evaluateAlerts(row: DatabaseRow, session: Session): Promise<void> {
        const cipher = this.deps.cipherFor(row.workspace_id);
        const alerts = await this.deps.repo.listEnabledAlerts(row.id);
        if (alerts.length === 0) return;

        const name = (await readJson<StoredDatabase>(cipher, row.content))?.name ?? 'base';
        const at = Math.floor(Date.now() / 1000);

        for (const alert of alerts) {
            const stored = await readJson<StoredAlert>(cipher, alert.content);
            if (!stored) continue;
            try {
                const outcomes = await runConditions(session, stored.conditions);
                const firing = isFiring(stored.conditions, outcomes, alert.combinator === 'or' ? 'or' : 'and');
                const wasFiring = alert.firing === 1;
                const failure = outcomes.find((o) => o.error !== null)?.error ?? null;

                await this.deps.repo.recordAlertCheck(alert.id, {
                    at,
                    firing,
                    firedAt: firing && !wasFiring ? at : null,
                    error: failure ? await cipher.encrypt(failure) : null,
                    content: await cipher.encrypt(
                        JSON.stringify({ ...stored, lastValues: outcomes.map((o) => o.value) } satisfies StoredAlert)
                    )
                });

                // Aux transitions seulement — dans les deux sens, pour qu'un
                // retour à la normale se sache sans avoir à aller vérifier.
                if (firing !== wasFiring) {
                    await this.notify(row.workspace_id, row.id, {
                        databaseName: name,
                        alertName: stored.name,
                        firing,
                        body: firing
                            ? renderMessage(stored.message, stored.conditions, outcomes)
                            : `L’alerte « ${stored.name} » sur ${name} est revenue à la normale.`,
                        at
                    });
                }
            } catch (e) {
                this.deps.logger.error(
                    { alertId: alert.id, err: e instanceof Error ? e.message : String(e) },
                    'Database alert evaluation failed'
                );
                await this.deps.repo
                    .recordAlertCheck(alert.id, {
                        at,
                        firing: alert.firing === 1,
                        firedAt: null,
                        error: await cipher.encrypt(explainError(e)),
                        content: alert.content
                    })
                    .catch(() => {
                        /* une écriture d'état perdue ne doit pas arrêter les autres alertes */
                    });
            }
        }
    }

    /**
     * Délivre une alerte sur les canaux de la feature **Bases de données**.
     *
     * Trois choses tenaient ici et n'y sont plus. Les canaux, empruntés à Uptime
     * — ce sont les siens depuis la migration 085. L'envoi, recopié mot pour mot
     * depuis `UptimeMonitor` alors que `Services/notifications.ts` existait
     * précisément pour l'éviter. Et la gestion d'erreur qui allait avec : c'est
     * `deliver`, derrière la façade `notify` du SDK, qui journalise puis avale,
     * canal par canal, pour qu'un webhook en panne ne supprime pas le mail ni
     * n'arrête la boucle de relevé. La façade rend `false` sans canal routé, ce
     * que ce service n'a pas à savoir : une alerte se tente, la route décide.
     */
    private async notify(
        workspaceId: number,
        // La base concernée : c'est elle qui décide de la route, et donc ce qui
        // permet d'envoyer les alertes de deux bases à deux endroits différents.
        databaseId: number,
        alert: { databaseName: string; alertName: string; firing: boolean; body: string; at: number }
    ): Promise<void> {
        await this.deps.deveyeFor(workspaceId).notify.send(
            {
                subject: alert.firing
                    ? `[DevEye] Alerte ${alert.databaseName} — ${alert.alertName}`
                    : `[DevEye] Retour à la normale ${alert.databaseName} — ${alert.alertName}`,
                body: alert.body,
                payload: {
                    event: alert.firing ? 'database_alert' : 'database_recovered',
                    database: alert.databaseName,
                    alert: alert.alertName,
                    at: alert.at
                },
                // La même alerte, mise en page pour Discord. Elle n'en avait pas :
                // les bases empruntaient les canaux d'Uptime jusqu'à la 085, et
                // n'ont jamais eu de forme propre depuis.
                embeds: buildNotice({
                    database: alert.databaseName,
                    alert: alert.alertName,
                    firing: alert.firing,
                    message: alert.body,
                    at: alert.at
                })
            },
            { itemId: databaseId }
        );
    }
}
