import type { AuthWindow, DeviceReport, IntegrityReport, MetricSnapshot, ReportProcess } from '@deveye/types';
import type { FeatureService, FeatureServiceDeps, SdkDevice } from '@deveye/types/sdk/server';

import {
    SENTINEL_RULES,
    SEVERITY_RANK,
    type BaselineAttrs,
    type FindingSeverity,
    type SentinelRuleId
} from '../contracts/domain';

import { env } from './env';
import { buildNotice } from './notice';
import {
    allowKey,
    findingDedup,
    type BaselineObservation,
    type BaselineRow,
    type FindingDraft,
    type SentinelRepo
} from './repo';
import {
    authRules,
    evaluateReport,
    evaluateSnapshot,
    isKernelThread,
    isWorldBound,
    listenerKey,
    persistenceRules,
    processKey,
    REPORT_RULES,
    SNAPSHOT_RULES,
    stableListenPorts,
    type EvalContext
} from './rules';

/**
 * Le moteur : un ticker du SDK monté par `createService`, qui tourne sans
 * session ni mot de passe (rien n'est chiffré côté Sentinelle).
 *
 * L'ingestion n'évalue pas. Un lot de métriques peut porter cent instants, et
 * évaluer dans le hook ferait payer la détection au chemin le plus chaud du
 * serveur : les hooks empilent, le tour de boucle draine, ne garde que le
 * dernier instant par appareil, et évalue. Même économie pour l'alerte, les
 * constats d'un même appareil dans un même tour partent en un seul message :
 * une machine compromise déclenche vingt règles d'un coup, et renotifier à
 * chaque tour rendrait le canal inutilisable en une nuit.
 */

/** Cadence de la passe lente : enveloppes, disparitions, balayage des résolus. */
const SLOW_PASS_MS = 60 * 60 * 1000;

/**
 * Plancher entre deux évaluations d'une même famille de règles pour un même
 * appareil. Ces familles sont nourries par des relevés horaires que l'agent
 * réémet à la connexion : sans plancher, une machine qui se reconnecte en boucle
 * les fait rejouer autant de fois. Dix minutes reste plus réactif que la cadence
 * horaire visée, rien n'est perdu en détection.
 */
const EVAL_FLOOR_MS = 10 * 60 * 1000;

/**
 * Le délai est-il écoulé depuis la dernière fois ? `undefined` veut dire
 * « jamais », donc oui. Extrait pour être vérifiable sans horloge.
 */
export function dueSince(lastMs: number | undefined, nowMs: number, floorMs: number): boolean {
    return lastMs === undefined || nowMs - lastMs >= floorMs;
}

/**
 * Dernière évaluation de chaque famille soumise au plancher. L'instant de
 * métriques n'y est pas : léger, à la minute, c'est lui qui porte la détection
 * réactive.
 */
type EvalMarks = { report?: number; auth?: number; integrity?: number };

/**
 * Combien d'instants d'absence avant de déclarer un programme disparu. Généreux
 * exprès : un programme qui redémarre entre deux relevés ne doit rien produire.
 */
const VANISHED_AFTER_SAMPLES = 10;

/** Ancienneté minimale d'un programme avant qu'on juge sa disparition notable. */
const VANISHED_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Au-delà de quelle absence un programme sort de la ligne de base sans rien
 * produire. Généreux exprès : oublier trop tôt ferait sonner `process.new` à
 * chaque exécution d'un programme intermittent, une sauvegarde nocturne ou un
 * gestionnaire de paquets.
 */
const BASELINE_FORGET_MS = 30 * 24 * 60 * 60 * 1000;

/** Lissage de l'enveloppe p95. Voir `blendP95`. */
const P95_ALPHA = 0.05;

/** Ce qu'un appareil a en attente d'évaluation. */
interface Pending {
    /** Le dernier instant reçu. Les précédents sont abandonnés : c'est l'état courant qui compte. */
    snapshotTs?: number;
    /** Un rapport est arrivé (posture, ports, connexions). */
    report?: boolean;
    integrity?: IntegrityReport;
    auth?: AuthWindow;
}

/** La ligne de base d'un appareil, telle que le moteur la tient en mémoire. */
interface BaselineCache {
    process: Map<string, BaselineRow>;
    listener: Map<string, BaselineRow>;
    persistence: Map<string, BaselineRow>;
}

/**
 * Une vraie p95 exigerait l'historique des mesures par programme, plus cher que
 * toute la détection. Cette moyenne mobile exponentielle en tient lieu : elle
 * suffit à répondre à « est-ce que ça sort largement de l'ordinaire ? », et le
 * seuil de déclenchement est grossier pour la même raison.
 */
function blendP95(previous: number | null, sample: number): number {
    if (previous === null) return sample;
    // L'enveloppe monte plus vite qu'elle ne redescend : sinon une nuit calme
    // l'abaisserait au point de faire sonner la reprise du matin.
    const alpha = sample > previous ? P95_ALPHA * 2 : P95_ALPHA;
    return previous + alpha * (sample - previous);
}

function mergeList(previous: string[], value: string | null, cap: number): string[] {
    if (!value || previous.includes(value)) return previous;
    return [...previous, value].slice(-cap);
}

function mergePorts(previous: number[], ports: number[], cap: number): number[] {
    const set = new Set(previous);
    for (const port of ports) set.add(port);
    return [...set].sort((a, b) => a - b).slice(0, cap);
}

function emptyAttrs(): BaselineAttrs {
    return { users: [], listenPorts: [], cpuP95: null, memP95: null, sha256: null, surface: null };
}

function attrsOf(row: BaselineRow | undefined): BaselineAttrs {
    if (!row) return emptyAttrs();
    return typeof row.attrs === 'string' ? emptyAttrs() : row.attrs;
}

export class SentinelEngine {
    private readonly ticker: FeatureService;
    private ticking = false;
    private lastSlowPass = 0;
    private readonly queue = new Map<string, Pending>();
    /**
     * La ligne de base, en mémoire : sûr parce que ce moteur en est le seul
     * écrivain et qu'il est unique par processus. Sans ce cache, chaque tour
     * relirait trois cents lignes par appareil pour constater que rien n'a changé.
     */
    private readonly baselines = new Map<string, BaselineCache>();
    /**
     * deviceId → dernière évaluation par famille, pour {@link EVAL_FLOOR_MS}. En
     * mémoire volontairement : une perte au redémarrage n'autorise qu'une
     * évaluation de plus.
     */
    private readonly lastEval = new Map<string, EvalMarks>();

    constructor(private readonly deps: FeatureServiceDeps<SentinelRepo>) {
        this.ticker = deps.createTicker({ intervalMs: env.SENTINEL_TICK_SECONDS * 1000, tick: () => this.tick() });
    }

    start(): void {
        this.ticker.start();
        this.deps.logger.info({ tickSeconds: env.SENTINEL_TICK_SECONDS }, 'Security monitor started');
    }

    async stop(): Promise<void> {
        await this.ticker.stop();
    }

    /** Oublie la ligne de base en mémoire d'un appareil (après une remise à zéro). */
    invalidate(deviceId: string): void {
        this.baselines.delete(deviceId);
        // Garder le plancher ferait attendre dix minutes la première évaluation que
        // la remise à zéro est justement censée provoquer.
        this.lastEval.delete(deviceId);
    }

    /**
     * Réserve le droit d'évaluer une famille de règles pour cet appareil, ou le
     * refuse si le plancher n'est pas écoulé. La marque est posée au passage :
     * deux appels rapprochés ne peuvent pas tous deux réussir.
     */
    private claimEvaluation(deviceId: string, kind: keyof EvalMarks, now: number): boolean {
        const marks = this.lastEval.get(deviceId) ?? {};
        if (!dueSince(marks[kind], now, EVAL_FLOOR_MS)) return false;
        marks[kind] = now;
        this.lastEval.set(deviceId, marks);
        return true;
    }

    /**
     * Les hooks agent : appelés une fois la télémétrie persistée, pour tout
     * appareil actif. C'est ici que le module relit sa config et décide qui est
     * surveillé. On empile, on n'évalue pas : le moteur relira le rapport depuis
     * la façade des appareils, d'où l'ordre (persistance d'abord, hook ensuite).
     */
    async onReport(deviceId: string): Promise<void> {
        if (!(await this.watched(deviceId))) return;
        this.enqueueReport(deviceId);
    }

    async onMetricsBatch(deviceId: string, snapshots: readonly MetricSnapshot[]): Promise<void> {
        // Seul le dernier instant d'un lot est signalé : évaluer les cent d'un agent
        // revenu après une coupure produirait des constats sur des états disparus.
        const latest = snapshots[snapshots.length - 1];
        if (!latest) return;
        if (!(await this.watched(deviceId))) return;
        this.enqueueSnapshot(deviceId, latest.timestamp);
    }

    async onIntegrity(deviceId: string, integrity: IntegrityReport): Promise<void> {
        if (!(await this.watched(deviceId))) {
            this.deps.logger.debug({ deviceId }, 'Sentinel probe dropped: device not watched');
            return;
        }
        this.enqueueIntegrity(deviceId, integrity);
        if (integrity.truncated) {
            // Un manifeste tronqué reste exploitable (le moteur s'interdit seulement
            // d'y conclure à des suppressions) mais signale une surface qui grossit.
            this.deps.logger.warn(
                { deviceId, entries: integrity.entries.length },
                'Sentinel: persistence manifest truncated (removals will not be reported)'
            );
        }
    }

    async onAuthEvents(deviceId: string, auth: AuthWindow): Promise<void> {
        const config = await this.deps.repo.deviceConfig.get(deviceId);
        if (!config || config.enabled !== 1) {
            this.deps.logger.debug({ deviceId }, 'Sentinel probe dropped: device not watched');
            return;
        }
        if (config.auth_events !== 1) {
            // La sonde a son propre interrupteur : un agent qui l'ignorerait ne doit
            // pas pouvoir imposer la lecture de journaux qu'on a refusée.
            this.deps.logger.warn(
                { deviceId },
                'Sentinel: auth window received while auth probing is disabled, dropped'
            );
            return;
        }
        this.enqueueAuth(deviceId, auth);
    }

    /** Sentinelle est-elle active sur cet appareil ? Sans ligne de config, non. */
    private async watched(deviceId: string): Promise<boolean> {
        const config = await this.deps.repo.deviceConfig.get(deviceId);
        return config?.enabled === 1;
    }

    /** Un instant est arrivé : on note son `ts`, on n'évalue pas. */
    enqueueSnapshot(deviceId: string, ts: number): void {
        const pending = this.queue.get(deviceId) ?? {};
        // Le plus récent gagne : évaluer un instant déjà dépassé produirait des
        // constats sur un état qui n'existe plus.
        if (pending.snapshotTs === undefined || ts > pending.snapshotTs) pending.snapshotTs = ts;
        this.queue.set(deviceId, pending);
    }

    enqueueReport(deviceId: string): void {
        const pending = this.queue.get(deviceId) ?? {};
        pending.report = true;
        this.queue.set(deviceId, pending);
    }

    /**
     * Le manifeste est gardé en entier dans la file, jamais relu depuis la base :
     * on ne le stocke pas brut, il n'existe qu'ici entre sa réception et son
     * évaluation. Un manifeste plus récent écrase le précédent, le diff porte sur
     * l'état courant.
     */
    enqueueIntegrity(deviceId: string, integrity: IntegrityReport): void {
        const pending = this.queue.get(deviceId) ?? {};
        pending.integrity = integrity;
        this.queue.set(deviceId, pending);
    }

    /**
     * Contrairement au manifeste, deux fenêtres d'authentification consécutives ne
     * s'écrasent pas, elles fusionnent : une fenêtre est additive, en perdre une
     * reviendrait à perdre les tentatives qu'elle comptait.
     */
    enqueueAuth(deviceId: string, auth: AuthWindow): void {
        const pending = this.queue.get(deviceId) ?? {};
        pending.auth = pending.auth ? mergeAuthWindows(pending.auth, auth) : auth;
        this.queue.set(deviceId, pending);
    }

    private async tick(): Promise<void> {
        if (this.ticking) return;
        this.ticking = true;
        try {
            const drained = [...this.queue.entries()];
            this.queue.clear();

            for (const [deviceId, pending] of drained) {
                try {
                    await this.evaluate(deviceId, pending);
                } catch (e) {
                    // Un appareil qui échoue ne doit pas emporter les autres : sa file
                    // est déjà vidée, il repartira au prochain relevé.
                    this.deps.logger.error(
                        { deviceId, err: e instanceof Error ? e.message : String(e) },
                        'Sentinel: device evaluation failed'
                    );
                }
            }

            const now = Date.now();
            if (now - this.lastSlowPass >= SLOW_PASS_MS) {
                this.lastSlowPass = now;
                await this.slowPass().catch((e) => {
                    this.deps.logger.error({ err: e }, 'Sentinel: slow pass failed');
                });
            }
        } finally {
            this.ticking = false;
        }
    }

    /** Charge (une fois) la ligne de base d'un appareil. */
    private async baselineOf(deviceId: string): Promise<BaselineCache> {
        const cached = this.baselines.get(deviceId);
        if (cached) return cached;
        const [process, listener, persistence] = await Promise.all([
            this.deps.repo.baseline.known(deviceId, 'process'),
            this.deps.repo.baseline.known(deviceId, 'listener'),
            this.deps.repo.baseline.known(deviceId, 'persistence')
        ]);
        const fresh = { process, listener, persistence };
        this.baselines.set(deviceId, fresh);
        return fresh;
    }

    private async evaluate(deviceId: string, pending: Pending): Promise<void> {
        const device = await this.deps.devices.find(deviceId);
        // Le garde est ici en plus de l'ingestion : un appareil peut être archivé,
        // ou la surveillance coupée, pendant qu'une file attend.
        if (!device || device.status !== 'active') return;
        const config = await this.deps.repo.deviceConfig.get(deviceId);
        if (!config || config.enabled !== 1) return;

        const now = Date.now();
        const learning = config.learning_until !== null && now < config.learning_until;
        const baseline = await this.baselineOf(deviceId);

        // Le rapport arrive déjà analysé par la façade des appareils ; l'instant
        // n'est relu que s'il y en a un en attente.
        const report = device.report;
        const snapshot = pending.snapshotTs ? await this.deps.telemetry.snapshot(deviceId, pending.snapshotTs) : null;

        const ctx: EvalContext = { now, learning, snapshot, report, baseline };

        const drafts: FindingDraft[] = [];
        // Chaque famille ne tourne que s'il y a de quoi la nourrir, et `replayed`
        // note laquelle : c'est ce qui autorise `record()` à résoudre les constats
        // devenus muets de cette famille-là, et d'aucune autre. Instant et rapport
        // restent distingués parce qu'ils arrivent à des cadences différentes
        // (60 s contre 1 h) : les confondre re-constaterait la posture chaque
        // minute, et résoudrait les constats d'instant au moindre rapport.
        const replayed: SentinelRuleId[] = [];
        if (snapshot !== null) {
            drafts.push(...evaluateSnapshot(ctx));
            replayed.push(...SNAPSHOT_RULES);
        }
        // Les trois familles périodiques passent par {@link EVAL_FLOOR_MS}, et
        // `replayed` reste dans le même bloc que son évaluation : l'annoncer sans
        // fournir de constats résoudrait la famille en bloc. Seule la relecture des
        // règles est bornée, pas l'ingestion.
        if (pending.report === true && this.claimEvaluation(deviceId, 'report', now)) {
            drafts.push(...evaluateReport(ctx));
            replayed.push(...REPORT_RULES);
        }
        if (pending.integrity && this.claimEvaluation(deviceId, 'integrity', now)) {
            drafts.push(...persistenceRules(ctx, pending.integrity.entries, pending.integrity.truncated));
        }
        if (pending.auth && this.claimEvaluation(deviceId, 'auth', now)) {
            drafts.push(...authRules(ctx, pending.auth));
        }

        const opened = await this.record(device, drafts, replayed, config.pin_evidence === 1);

        // La ligne de base s'écrit après l'évaluation : l'inverse rendrait un
        // programme nouveau déjà connu, et `process.new` ne sonnerait jamais.
        if (snapshot) await this.observeSnapshot(deviceId, snapshot, baseline, now);
        if (report?.openPorts) await this.observeListeners(deviceId, report.openPorts, baseline, now);
        if (pending.integrity) {
            await this.observePersistence(deviceId, pending.integrity, baseline, now);
            await this.deps.repo.deviceConfig.touchIntegrity(deviceId, pending.integrity.collectedAt);
        }

        if (opened.length > 0) await this.announce(device, opened);
    }

    /**
     * Confronte les constats produits à ceux en base, et rend ceux qui viennent
     * de s'ouvrir, les seuls qui méritent une notification.
     */
    private async record(
        device: SdkDevice,
        drafts: FindingDraft[],
        replayed: SentinelRuleId[],
        pinEvidence: boolean
    ): Promise<{ draft: FindingDraft; id: number }[]> {
        const now = Date.now();
        const workspaceId = device.workspaceId;
        // Les autorisations sont portées par l'espace : un appareil orphelin n'en a
        // plus aucune à consulter.
        const allowed =
            workspaceId !== null ? await this.deps.repo.allow.forDevice(workspaceId, device.id) : new Set<string>();

        const kept = drafts.filter((d) => !allowed.has(allowKey(d.rule, d.subject)));
        const opened: { draft: FindingDraft; id: number }[] = [];
        const seen: Buffer[] = [];

        for (const draft of kept) {
            const outcome = await this.deps.repo.findings.upsert(device.id, draft, now);
            seen.push(findingDedup(draft.rule, draft.subject));
            if (outcome.isNew) opened.push({ draft, id: outcome.id });
        }

        // Ce qui ne se déclenche plus se résout, mais seulement pour les règles qu'on
        // vient de rejouer : résoudre la posture parce qu'un lot de métriques est
        // arrivé dirait qu'un réglage a changé sans que personne ne l'ait relu.
        // `resolveMissing` filtre par jeu de règles, `seen` reste donc l'union de
        // tout ce qu'on a produit.
        if (replayed.length > 0) {
            await this.deps.repo.findings.resolveMissing(device.id, replayed, seen, now);
        }

        // Épingler l'instant qui porte la preuve, pour les constats sérieux : sans
        // cela la rétention effacerait la seule liste de processus qui explique le
        // constat. `pinInstant` épingle les deux tables en une instruction, une
        // preuve à moitié épinglée disparaissant à la purge suivante. Refusable
        // par appareil : ces instants gardés se voient dans l'historique de
        // Monitoring, et tout le monde ne veut pas les y trouver.
        const toPin = pinEvidence
            ? [
                  ...new Set(
                      opened
                          .filter(
                              ({ draft }) =>
                                  SEVERITY_RANK[draft.severity] >= SEVERITY_RANK.high && draft.snapshotTs !== null
                          )
                          .map(({ draft }) => draft.snapshotTs!)
                  )
              ]
            : [];
        for (const ts of toPin) {
            try {
                await this.deps.telemetry.pinInstant(device.id, ts);
            } catch (e) {
                // Une preuve non épinglée reste un constat valide : on journalise et on
                // continue, plutôt que de perdre le constat lui-même.
                this.deps.logger.warn(
                    { deviceId: device.id, ts, err: e instanceof Error ? e.message : String(e) },
                    'Sentinel: could not pin evidence snapshot'
                );
            }
        }

        return opened;
    }

    private async observeSnapshot(
        deviceId: string,
        snapshot: { ts: number; processes: ReportProcess[] },
        baseline: BaselineCache,
        at: number
    ): Promise<void> {
        if (snapshot.processes.length === 0) return;
        const items: BaselineObservation[] = [];

        for (const p of snapshot.processes) {
            // Un fil du noyau n'entre pas dans la ligne de base : le noyau recycle
            // ses noms en continu, et chacun deviendrait un élément qui apparaît
            // puis disparaît. Écarté ici plutôt que dans les seules règles, sans
            // quoi la table grossirait d'autant de lignes mortes.
            if (isKernelThread(p)) continue;
            const key = processKey(p);
            const known = baseline.process.get(key);
            const previous = attrsOf(known);
            // Fusion, jamais remplacement : `observe` écrit `attrs` en bloc, et
            // écraser ferait sonner `process.user_changed` à chaque alternance de
            // compte, l'enveloppe étant en plus recalculée depuis une seule mesure.
            const attrs: BaselineAttrs = {
                ...previous,
                users: mergeList(previous.users, p.user, 16),
                listenPorts: mergePorts(previous.listenPorts, stableListenPorts(p.listenPorts), 64),
                cpuP95: blendP95(previous.cpuP95, p.cpuPercent),
                memP95: previous.memP95 === null ? p.memBytes : Math.max(previous.memP95, p.memBytes)
            };
            items.push({ kind: 'process', key, attrs });
            // Le cache suit l'écriture : le prochain tour doit voir ce tour-ci.
            baseline.process.set(key, {
                ...(known ?? {
                    id: 0,
                    device_id: deviceId,
                    kind: 'process' as const,
                    item_key: key,
                    first_seen: at,
                    samples: 0
                }),
                last_seen: at,
                samples: (known?.samples ?? 0) + 1,
                attrs
            } as BaselineRow);
        }

        await this.deps.repo.baseline.observe(deviceId, at, items);
    }

    private async observeListeners(
        deviceId: string,
        ports: NonNullable<DeviceReport['openPorts']>,
        baseline: BaselineCache,
        at: number
    ): Promise<void> {
        const items: BaselineObservation[] = [];
        for (const port of ports) {
            const key = listenerKey(port.proto, port.address, port.port);
            const known = baseline.listener.get(key);
            const attrs: BaselineAttrs = {
                ...attrsOf(known),
                users: mergeList(attrsOf(known).users, port.process, 16),
                listenPorts: [port.port],
                surface: isWorldBound(port.address) ? 'world' : 'local'
            };
            items.push({ kind: 'listener', key, attrs });
            baseline.listener.set(key, {
                ...(known ?? {
                    id: 0,
                    device_id: deviceId,
                    kind: 'listener' as const,
                    item_key: key,
                    first_seen: at,
                    samples: 0
                }),
                last_seen: at,
                samples: (known?.samples ?? 0) + 1,
                attrs
            } as BaselineRow);
        }
        if (items.length > 0) await this.deps.repo.baseline.observe(deviceId, at, items);
    }

    private async observePersistence(
        deviceId: string,
        integrity: IntegrityReport,
        baseline: BaselineCache,
        at: number
    ): Promise<void> {
        const items: BaselineObservation[] = integrity.entries.map((entry) => ({
            kind: 'persistence' as const,
            key: entry.path,
            attrs: { ...emptyAttrs(), sha256: entry.sha256, surface: entry.surface }
        }));

        // Ce qui a disparu du manifeste sort de la ligne de base : sans cela, un
        // fichier supprimé puis recréé à l'identique produirait éternellement
        // `persistence.removed`. Un manifeste tronqué ne prouve rien, on n'y touche
        // pas (même raison que dans `persistenceRules`).
        if (!integrity.truncated) {
            const present = new Set(integrity.entries.map((e) => e.path));
            const gone = [...baseline.persistence.keys()].filter((path) => !present.has(path));
            if (gone.length > 0) {
                await this.deps.repo.baseline.forget(deviceId, 'persistence', gone);
                for (const path of gone) baseline.persistence.delete(path);
            }
        }

        if (items.length === 0) return;
        await this.deps.repo.baseline.observe(deviceId, at, items);
        for (const item of items) {
            const known = baseline.persistence.get(item.key);
            baseline.persistence.set(item.key, {
                ...(known ?? {
                    id: 0,
                    device_id: deviceId,
                    kind: 'persistence' as const,
                    item_key: item.key,
                    first_seen: at,
                    samples: 0
                }),
                last_seen: at,
                samples: (known?.samples ?? 0) + 1,
                attrs: item.attrs
            } as BaselineRow);
        }
    }

    /**
     * Ce qui ne se décide pas sur un instant : les programmes disparus et le
     * balayage des constats résolus. La flotte surveillée vient du dépôt du
     * module, la façade des appareils disant lesquels sont encore actifs.
     */
    private async slowPass(): Promise<void> {
        const now = Date.now();

        for (const deviceId of await this.deps.repo.deviceConfig.listEnabled()) {
            const device = await this.deps.devices.find(deviceId);
            if (!device || device.status !== 'active') continue;
            const config = await this.deps.repo.deviceConfig.get(deviceId);
            if (!config || config.enabled !== 1) continue;
            if (config.learning_until !== null && now < config.learning_until) continue;
            const interval = (device.metricIntervalSeconds ?? 60) * 1000;
            const stale = await this.deps.repo.baseline.staleSince(
                device.id,
                'process',
                now - VANISHED_AFTER_SAMPLES * interval
            );
            // Un programme aperçu trois fois la semaine dernière n'a pas disparu :
            // il n'était pas installé, il passait.
            const gone = stale.filter((row) => now - row.first_seen >= VANISHED_MIN_AGE_MS && row.samples >= 500);
            const drafts: FindingDraft[] = gone.map((row) => ({
                rule: 'process.vanished' as SentinelRuleId,
                severity: SENTINEL_RULES['process.vanished'].severity,
                subject: row.item_key,
                evidence: [
                    { label: 'Programme', value: row.item_key },
                    { label: 'Vu pour la dernière fois', value: new Date(row.last_seen).toISOString() },
                    { label: 'Connu depuis', value: new Date(row.first_seen).toISOString().slice(0, 10) },
                    { label: 'Instants observés', value: String(row.samples) }
                ],
                snapshotTs: null
            }));

            // Ce qui a produit sa disparition sort de la ligne de base, comme le
            // manifeste de persistance : la ligne a dit tout ce qu'elle avait à
            // dire, et la garder ferait re-constater la même disparition à chaque
            // passe, indéfiniment. Le reste ne part qu'après une longue absence.
            const forget = [
                ...gone.map((row) => row.item_key),
                ...stale.filter((row) => now - row.last_seen >= BASELINE_FORGET_MS).map((row) => row.item_key)
            ];
            if (forget.length > 0) {
                await this.deps.repo.baseline.forget(device.id, 'process', forget);
                const cached = this.baselines.get(device.id);
                // Le cache doit suivre, sinon le retour du programme ne serait pas
                // vu comme nouveau : la base l'aurait oublié, pas la mémoire.
                if (cached) for (const key of forget) cached.process.delete(key);
            }

            if (drafts.length === 0) continue;
            // Aucune famille rejouée : `process.vanished` se constate par absence,
            // c'est le retour du programme qui le ferme, pas ce balayage.
            const opened = await this.record(device, drafts, [], config.pin_evidence === 1);
            if (opened.length > 0) await this.announce(device, opened);
        }

        const pruned = await this.deps.repo.findings.pruneResolved(env.SENTINEL_FINDING_RETENTION_DAYS);
        if (pruned > 0) this.deps.logger.info({ pruned }, 'Sentinel: resolved findings pruned');
    }

    /**
     * Journalise, réveille les vues, et notifie si ça le mérite. Le groupage est
     * la partie qui compte : vingt mails simultanés ne se lisent pas, la première
     * réaction de qui les reçoit est de créer une règle de filtrage.
     */
    private async announce(device: SdkDevice, opened: { draft: FindingDraft; id: number }[]): Promise<void> {
        for (const { draft } of opened) {
            this.deps.audit({
                level: SEVERITY_RANK[draft.severity] >= SEVERITY_RANK.high ? 'warning' : 'info',
                action: draft.rule,
                // Le moteur n'a pas d'acteur, il tourne sans session : on attribue
                // au propriétaire de l'appareil.
                userId: device.ownerUserId,
                description: `${SENTINEL_RULES[draft.rule].label} sur « ${device.name} » : ${draft.subject}`,
                metadata: { deviceId: device.id, rule: draft.rule, subject: draft.subject }
            });
        }

        if (device.workspaceId !== null) this.deps.live.changed(device.workspaceId);

        const notifiable = opened.filter(({ draft }) => SEVERITY_RANK[draft.severity] >= SEVERITY_RANK.high);
        if (notifiable.length === 0 || device.workspaceId === null) return;

        const worst = notifiable.reduce(
            (acc, { draft }) => (SEVERITY_RANK[draft.severity] > SEVERITY_RANK[acc] ? draft.severity : acc),
            'high' as FindingSeverity
        );
        const lines = notifiable.map(
            ({ draft }) => `• [${draft.severity}] ${SENTINEL_RULES[draft.rule].label} : ${draft.subject}`
        );
        // La règle du constat le plus grave donne son titre à l'embed : ce qu'on doit
        // lire en premier est ce qui a été enfreint, pas le nombre de constats.
        const lead = notifiable.reduce(
            (acc, item) => (SEVERITY_RANK[item.draft.severity] > SEVERITY_RANK[acc.draft.severity] ? item : acc),
            notifiable[0]!
        );
        const body = [
            `Sentinelle a ouvert ${notifiable.length} constat${notifiable.length > 1 ? 's' : ''} sur « ${device.name} ».`,
            '',
            ...lines,
            '',
            SENTINEL_RULES[notifiable[0]!.draft.rule].remediation
        ].join('\n');

        await this.notify(device.workspaceId, {
            deviceName: device.name,
            severity: worst,
            count: notifiable.length,
            body,
            at: Math.floor(Date.now() / 1000),
            rule: SENTINEL_RULES[lead.draft.rule].label,
            remediation: SENTINEL_RULES[lead.draft.rule].remediation
        });
        await this.deps.repo.findings.markNotified(notifiable.map((n) => n.id));
    }

    /**
     * Délivre sur les canaux de Sentinelle, et sur aucun autre : emprunter un
     * canal qu'on n'a pas désigné pour la sécurité revient à écrire à des gens
     * sans le leur avoir demandé. Sans canal routé, la façade `notify` ne fait
     * rien et avale les erreurs de livraison : un webhook en panne ne doit ni
     * supprimer le mail, ni arrêter la boucle.
     */
    private async notify(
        workspaceId: number,
        alert: {
            deviceName: string;
            severity: FindingSeverity;
            count: number;
            body: string;
            at: number;
            /** L'intitulé de la règle du constat le plus grave, le titre de l'embed. */
            rule: string;
            remediation: string | null;
        }
    ): Promise<void> {
        await this.deps.deveyeFor(workspaceId).notify.send({
            subject: `[DevEye] Sentinelle ${alert.severity} : ${alert.deviceName}`,
            body: alert.body,
            payload: {
                event: 'sentinel_finding',
                device: alert.deviceName,
                severity: alert.severity,
                count: alert.count,
                at: alert.at
            },
            embeds: buildNotice({
                device: alert.deviceName,
                rule: alert.rule,
                severity: alert.severity === 'critical' ? 'critical' : alert.severity === 'high' ? 'high' : 'low',
                detail: alert.body,
                remediation: alert.remediation,
                at: alert.at
            })
        });
    }
}

/**
 * Fusionne deux fenêtres d'authentification consécutives. `unavailable` est vrai
 * dès qu'une des deux l'était : si une moitié de la période n'a pas pu être lue,
 * on ne peut pas prétendre avoir tout vu.
 */
function mergeAuthWindows(a: AuthWindow, b: AuthWindow): AuthWindow {
    const sources = new Map<string, { address: string; failed: number; accepted: number; users: string[] }>();
    for (const source of [...a.topSources, ...b.topSources]) {
        const existing = sources.get(source.address);
        if (!existing) {
            sources.set(source.address, { ...source, users: [...source.users] });
            continue;
        }
        existing.failed += source.failed;
        existing.accepted += source.accepted;
        existing.users = [...new Set([...existing.users, ...source.users])].slice(0, 16);
    }
    return {
        from: Math.min(a.from, b.from),
        to: Math.max(a.to, b.to),
        failed: a.failed + b.failed,
        accepted: a.accepted + b.accepted,
        invalidUser: a.invalidUser + b.invalidUser,
        sudo: a.sudo + b.sudo,
        newAccounts: [...new Set([...a.newAccounts, ...b.newAccounts])].slice(0, 16),
        rootLogins: a.rootLogins + b.rootLogins,
        topSources: [...sources.values()].sort((x, y) => y.failed - x.failed).slice(0, 50),
        logins: [...a.logins, ...b.logins].slice(-50),
        unavailable: a.unavailable || b.unavailable,
        truncated: a.truncated || b.truncated
    };
}
