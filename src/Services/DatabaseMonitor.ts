import type { Logger } from 'pino';
import type { Database as Db } from '@/db';
import type Encryption from '@/Services/Encryption';
import type { LiveHub } from '@/live/hub';
import { createOpenCipher, type Cipher } from '@/Services/SecureStore';
import { deliver, hasChannel, resolveRoute } from '@/Services/notifications';
import { buildNotice } from '@/Services/notices/database';
import type { DatabaseComparator, DatabaseCondition, DatabaseProbe, DatabaseRow } from '@deveye/types';
import { explainError, openSession, singleNumber, type EngineTarget, type Session } from './databases/engine';
import type { TunnelConfig } from './databases/tunnel';

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
 * `UptimeMonitor` a disparu avec sa cause.
 *
 * ## Notifier aux transitions, jamais à chaque relevé
 *
 * `database_alerts.firing` porte l'état courant. Une alerte franchie qui le
 * reste ne renotifie pas : sans cela, une base qui dépasse son seuil pendant la
 * nuit enverrait un message toutes les cinq minutes, et le lendemain personne ne
 * lirait plus aucune alerte.
 */

/** Cadence de l'ordonnanceur. La cadence *par base* est sa propre colonne. */
const TICK_SECONDS = 30;

/** Bases relevées par tour : borne la rafale de connexions sortantes. */
const BATCH = 4;

/** Ce que porte `database_alerts.content`, chiffré. */
export interface StoredAlert {
    name: string;
    conditions: DatabaseCondition[];
    message: string;
    /** Ce qu'a mesuré la dernière évaluation, condition par condition. */
    lastValues: (number | null)[];
}

/** Ce que porte `database_connections.content`, chiffré. */
export interface StoredDatabase {
    name: string;
    host: string;
    port: number;
    database: string;
    username: string;
    /**
     * Charger les tables à l'ouverture de la fiche.
     *
     * Ici et non dans une colonne : c'est un réglage d'affichage, il n'entre
     * dans aucune requête et ne se trie sur rien. Le blob chiffré est fait pour
     * ça, et l'ajouter n'a donc coûté aucune migration.
     */
    autoLoadTables?: boolean;
}

/** Ce que porte `database_connections.access_content`, chiffré. */
export interface StoredAccess {
    kind: TunnelConfig['kind'];
    host: string;
    port: number | null;
    username: string;
    auth: TunnelConfig['auth'];
}

export interface DatabaseMonitorDeps {
    db: Db;
    crypt: Encryption;
    logger: Logger;
    live?: LiveHub;
}

/** L'issue d'une évaluation de condition : une valeur, ou la raison de son absence. */
export interface ConditionOutcome {
    value: number | null;
    error: string | null;
}

/** Compare une mesure à son seuil. */
export function compare(value: number, comparator: DatabaseComparator, threshold: number): boolean {
    switch (comparator) {
        case 'gt':
            return value > threshold;
        case 'gte':
            return value >= threshold;
        case 'lt':
            return value < threshold;
        case 'lte':
            return value <= threshold;
        case 'eq':
            return value === threshold;
        case 'ne':
            return value !== threshold;
        default:
            // Le `default` n'est pas décoratif : il rend la fonction totale pour
            // le compilateur tout en restant inatteignable, l'entrée étant
            // validée par `databaseComparatorSchema`.
            return false;
    }
}

/**
 * Évalue chaque condition sur une session ouverte.
 *
 * Une condition en échec **n'interrompt pas** les autres : on veut voir d'un
 * coup d'œil laquelle des cinq est mal écrite, pas découvrir la deuxième après
 * avoir corrigé la première.
 */
export async function runConditions(session: Session, conditions: DatabaseCondition[]): Promise<ConditionOutcome[]> {
    const out: ConditionOutcome[] = [];
    for (const condition of conditions) {
        try {
            out.push({ value: singleNumber(await session.query(condition.sql)), error: null });
        } catch (e) {
            out.push({ value: null, error: explainError(e) });
        }
    }
    return out;
}

/**
 * L'alerte est-elle franchie ?
 *
 * Une condition qui n'a pas pu être mesurée **ne franchit pas** : en `and` elle
 * empêche le déclenchement, en `or` elle ne l'entraîne pas. Le contraire ferait
 * d'une requête mal écrite une source d'alertes permanentes, ce qui est la
 * meilleure façon de faire ignorer un canal d'alerte.
 */
export function isFiring(
    conditions: DatabaseCondition[],
    outcomes: ConditionOutcome[],
    combinator: 'and' | 'or'
): boolean {
    const met = conditions.map((condition, i) => {
        const outcome = outcomes[i];
        if (!outcome || outcome.value === null) return false;
        return compare(outcome.value, condition.comparator, condition.threshold);
    });
    return combinator === 'and' ? met.every(Boolean) : met.some(Boolean);
}

/** Remplace `{label}` par la valeur mesurée de la condition portant ce nom. */
export function renderMessage(message: string, conditions: DatabaseCondition[], outcomes: ConditionOutcome[]): string {
    return message.replace(/\{([^{}]{1,96})\}/g, (whole, label: string) => {
        const i = conditions.findIndex((c) => c.label === label);
        if (i === -1) return whole;
        const value = outcomes[i]?.value;
        return value === null || value === undefined ? '—' : String(value);
    });
}

export class DatabaseMonitor {
    private timer: ReturnType<typeof setInterval> | null = null;
    private ticking = false;
    /** Une base à la fois : deux relevés simultanés ouvriraient deux tunnels. */
    private readonly inFlight = new Map<number, Promise<DatabaseProbe>>();
    private readonly ciphers = new Map<number, Cipher>();

    constructor(private readonly deps: DatabaseMonitorDeps) {}

    start(): void {
        if (this.timer) return;
        this.timer = setInterval(() => void this.tick(), TICK_SECONDS * 1000);
        this.timer.unref();
        this.deps.logger.info({ tickSeconds: TICK_SECONDS }, 'Database monitor started');
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

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
            const due = await this.deps.db.databases.listDue(now, BATCH);
            await Promise.all(due.map((row) => this.checkNow(row.id, row.workspace_id)));
        } catch (e) {
            this.deps.logger.error({ err: e }, 'Database monitor: tick failed');
        } finally {
            this.ticking = false;
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
        const cipher = this.cipherFor(workspaceId);
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
        const row = await this.deps.db.databases.find(databaseId, workspaceId);
        if (!row) return { ok: false, serverVersion: null, elapsedMs: 0, error: 'Base introuvable.' };

        const cipher = this.cipherFor(workspaceId);
        let session: Session | null = null;
        try {
            session = await openSession(await this.targetOf(row, workspaceId));
            const inventory = await session.inventory();
            await this.deps.db.databases.recordCheck(databaseId, {
                at: Math.floor(Date.now() / 1000),
                elapsedMs: Date.now() - started,
                status: 'up',
                error: null,
                serverVersion: inventory.serverVersion.slice(0, 255),
                sizeBytes: inventory.sizeBytes,
                tableCount: inventory.tableCount
            });
            await this.evaluateAlerts(row, session);
            this.deps.live?.changed(workspaceId, ['database'], null);
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
            await this.deps.db.databases.recordCheck(databaseId, {
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
            this.deps.live?.changed(workspaceId, ['database'], null);
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
        const cipher = this.cipherFor(row.workspace_id);
        const alerts = await this.deps.db.databases.listEnabledAlerts(row.id);
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

                await this.deps.db.databases.recordAlertCheck(alert.id, {
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
                await this.deps.db.databases
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
     * `deliver` qui journalise puis avale, canal par canal, pour qu'un webhook
     * en panne ne supprime pas le mail ni n'arrête la boucle de relevé.
     */
    private async notify(
        workspaceId: number,
        // La base concernée : c'est elle qui décide de la route, et donc ce qui
        // permet d'envoyer les alertes de deux bases à deux endroits différents.
        databaseId: number,
        alert: { databaseName: string; alertName: string; firing: boolean; body: string; at: number }
    ): Promise<void> {
        const channels = await resolveRoute(
            this.deps.db,
            this.cipherFor(workspaceId),
            workspaceId,
            'database',
            databaseId
        );
        if (!hasChannel(channels)) return;

        await deliver(
            channels,
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
            this.deps.logger.child({ workspaceId })
        );
    }
}

/** Déchiffre et parse, sans jamais lever : `null` dit simplement « illisible ». */
async function readJson<T>(cipher: Cipher, blob: string | null): Promise<T | null> {
    if (!blob) return null;
    const plain = await cipher.tryDecrypt(blob);
    if (plain === null) return null;
    try {
        return JSON.parse(plain) as T;
    } catch {
        return null;
    }
}
