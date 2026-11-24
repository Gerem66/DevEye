import type { DatabaseProbe, DatabaseRow } from '../contracts/domain';
import {
    logFailure,
    mapLimit,
    relayForAuthor,
    type FeatureService,
    type FeatureServiceDeps,
    type SdkCipher
} from '@deveye/types/sdk/server';

import { explainError, isTargetFailure, openSession, type EngineTarget, type Session } from './engine';
import { buildNotice } from './notice';
import type { DatabaseRepo } from './repo';
import { isFiring, measure, renderMessage, runConditions } from './rules';
import {
    GUARDED_ABSENT,
    PLAN_PAUSED_MESSAGE,
    readJson,
    type StoredAccess,
    type StoredAlert,
    type StoredDatabase,
    keepKpiValues,
    type StoredKpi,
    type StoredKpiValues
} from './_shared';

/**
 * Le relevé périodique des bases, et l'évaluation de leurs alertes. Éteint par
 * défaut, base par base : seule une base à `monitor_enabled = 1` entre dans la
 * boucle, et une alerte n'est évaluée que si le relevé est actif. Notifie aux
 * transitions seulement (`database_alerts.firing`), par la façade `notify` du
 * SDK sur la route de la base. Tourne sans session : codec ouvert de l'espace.
 * Une base protégée n'y entre donc jamais : elle n'est relevée que par une
 * commande, qui apporte le chiffre de la session.
 */

/** Cadence de l'ordonnanceur ; la cadence par base est sa propre colonne. */
const TICK_SECONDS = 30;

/** Bases relevées par tour, et connexions sortantes ouvertes à la fois. */
const BATCH = 16;
const CONCURRENCY = 6;

/** La couture de test : l'ouverture de session, injectable ; rien d'autre ne se simule. */
export interface DatabaseEngine {
    openSession(target: EngineTarget): Promise<Session>;
}

export class DatabaseMonitor {
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

    async stop(): Promise<void> {
        await this.ticker.stop();
    }

    private async tick(): Promise<void> {
        try {
            const now = Math.floor(Date.now() / 1000);
            const due = await this.deps.repo.listDue(now, BATCH, this.deps.pauses.paused('connections').map(Number));
            await mapLimit(due, CONCURRENCY, (row) => this.checkNow(row.id, row.workspace_id));
        } catch (e) {
            this.deps.logger.error({ err: e }, 'Database monitor: tick failed');
        }
    }

    /**
     * Relève une base maintenant, alertes comprises ; le même chemin pour
     * l'ordonnanceur et `database.inspect`. Ne lève jamais.
     */
    checkNow(databaseId: number, workspaceId: number, secrets?: SdkCipher): Promise<DatabaseProbe> {
        const running = this.inFlight.get(databaseId);
        if (running) return running;
        const task = this.runCheck(databaseId, workspaceId, secrets).finally(() => this.inFlight.delete(databaseId));
        this.inFlight.set(databaseId, task);
        return task;
    }

    /**
     * La cible de connexion d'une ligne, secrets déchiffrés. Jamais rendue au
     * client. Les secrets d'une base protégée ne s'ouvrent que par `secrets`,
     * le chiffre de la session qu'une commande apporte : sans lui, elle est
     * hors de portée, et le dit.
     */
    async targetOf(row: DatabaseRow, workspaceId: number, secrets?: SdkCipher): Promise<EngineTarget> {
        const cipher = this.deps.cipherFor(workspaceId);
        if (row.security_tier === 'guarded' && !secrets) throw new Error(GUARDED_ABSENT);
        const sealed = secrets ?? cipher;
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
            password: row.secret_enc ? await sealed.tryDecrypt(row.secret_enc) : null,
            access: {
                ...access,
                secret: row.access_secret_enc ? await sealed.tryDecrypt(row.access_secret_enc) : null,
                relay:
                    access.kind === 'device' ? await relayForAuthor(this.deps, workspaceId, access, 'cette base') : null
            }
        };
    }

    private async runCheck(databaseId: number, workspaceId: number, secrets?: SdkCipher): Promise<DatabaseProbe> {
        // Rien n'est écrit : le dernier relevé reste celui d'avant la pause.
        if (this.deps.pauses.isPaused('connections', String(databaseId))) {
            return { ok: false, serverVersion: null, elapsedMs: 0, error: PLAN_PAUSED_MESSAGE };
        }
        const started = Date.now();
        const row = await this.deps.repo.find(databaseId, workspaceId);
        if (!row) return { ok: false, serverVersion: null, elapsedMs: 0, error: 'Base introuvable.' };
        // Sans le chiffre d'une session, une base protégée n'est pas relevée, et rien n'est écrit.
        if (row.security_tier === 'guarded' && !secrets) {
            return { ok: false, serverVersion: null, elapsedMs: 0, error: GUARDED_ABSENT };
        }

        const cipher = this.deps.cipherFor(workspaceId);
        let session: Session | null = null;
        try {
            session = await this.engine.openSession(await this.targetOf(row, workspaceId, secrets));
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
            // Une base protégée n'a pas d'alerte : ses indicateurs, eux, se mesurent quand on la relève.
            if (row.security_tier !== 'guarded') await this.evaluateAlerts(row, session);
            await this.measureKpis(row, session);
            this.deps.live.changed(workspaceId);
            return {
                ok: true,
                serverVersion: inventory.serverVersion,
                elapsedMs: Date.now() - started,
                error: null
            };
        } catch (e) {
            const message = explainError(e);
            // Le message brut aux journaux, la phrase claire à l'écran.
            logFailure(
                this.deps.logger,
                isTargetFailure(e),
                { databaseId, err: e instanceof Error ? e.message : String(e) },
                'Database check failed'
            );
            await this.deps.repo.recordCheck(databaseId, {
                at: Math.floor(Date.now() / 1000),
                // Le temps d'un échec compte : douze secondes disent un délai
                // d'attente, pas un refus immédiat.
                elapsedMs: Date.now() - started,
                status: 'down',
                error: await cipher.encrypt(message),
                // Version et taille connues sont conservées : la dernière fois
                // où l'on a pu regarder.
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

    /**
     * Mesure les indicateurs. Le résultat se range sur les définitions relues à
     * l'écriture : un indicateur enregistré pendant le relevé garde la mesure
     * de son enregistrement, un indicateur retiré perd la sienne.
     */
    private async measureKpis(row: DatabaseRow, session: Session): Promise<void> {
        const cipher = this.deps.cipherFor(row.workspace_id);
        const kpis = (await readJson<StoredKpi[]>(cipher, row.kpis)) ?? [];
        if (kpis.length === 0) return;
        const at = Math.floor(Date.now() / 1000);
        const measured: StoredKpiValues = {};
        for (const kpi of kpis) measured[kpi.id] = { sql: kpi.sql, ...(await measure(session, kpi.sql)), at };
        try {
            const fresh = await this.deps.repo.find(row.id, row.workspace_id);
            const current = (await readJson<StoredKpi[]>(cipher, fresh?.kpis ?? null)) ?? [];
            const before = (await readJson<StoredKpiValues>(cipher, fresh?.kpi_values ?? null)) ?? {};
            await this.deps.repo.recordKpiValues(
                row.id,
                await cipher.encrypt(JSON.stringify(keepKpiValues(current, { ...before, ...measured })))
            );
        } catch (e) {
            this.deps.logger.error({ databaseId: row.id, err: e }, 'Database KPI write failed');
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

                // Aux transitions seulement, dans les deux sens.
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
     * Délivre une alerte par la façade `notify` du SDK, qui journalise et avale
     * les échecs canal par canal : un webhook en panne n'arrête pas le relevé.
     */
    private async notify(
        workspaceId: number,
        // La base décide de la route.
        databaseId: number,
        alert: { databaseName: string; alertName: string; firing: boolean; body: string; at: number }
    ): Promise<void> {
        await this.deps.deveyeFor(workspaceId).notify.send(
            {
                subject: alert.firing
                    ? `[DevEye] Alerte ${alert.databaseName} : ${alert.alertName}`
                    : `[DevEye] Retour à la normale ${alert.databaseName} : ${alert.alertName}`,
                body: alert.body,
                payload: {
                    event: alert.firing ? 'database_alert' : 'database_recovered',
                    database: alert.databaseName,
                    alert: alert.alertName,
                    at: alert.at
                },
                // La même alerte, mise en page pour Discord.
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
