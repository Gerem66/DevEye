import type { Logger } from 'pino';

import type { Database as Db } from '@/db';
import type { LiveHub } from '@/live/hub';
import type { AuditLog } from '@/Services/AuditLog';
import type Encryption from '@/Services/Encryption';
import { createOpenCipher, type Cipher } from '@/Services/SecureStore';
import { deliver, hasChannel, resolveRoute } from '@/Services/notifications';
import { buildNotice } from '@/Services/notices/sentinel';
import { env } from '@/Utils/Env';
import { allowKey, type BaselineObservation, type BaselineRow, findingDedup } from '@/db/repos/sentinel';
import {
    SENTINEL_RULES,
    SEVERITY_RANK,
    type AuthWindow,
    type BaselineAttrs,
    type DeviceReport,
    type DeviceRow,
    type FindingSeverity,
    type IntegrityReport,
    type ReportProcess,
    type SentinelRuleId
} from 'deveye-types';

import {
    authRules,
    evaluateReport,
    evaluateSnapshot,
    isWorldBound,
    listenerKey,
    persistenceRules,
    processKey,
    REPORT_RULES,
    SNAPSHOT_RULES,
    type EvalContext,
    type FindingDraft,
    type SnapshotView
} from './security/rules';

/**
 * Le moteur de Sentinelle.
 *
 * Même forme que `UptimeMonitor` et `DatabaseMonitor` : un `setInterval`, une
 * garde de recouvrement, construit dans `app.ts` et démarré depuis `index.ts`.
 * Il tourne **sans session et sans mot de passe** — d'où le choix de ne rien
 * chiffrer côté Sentinelle (voir la migration 074).
 *
 * ## L'ingestion n'évalue pas
 *
 * C'est l'invariant principal. Un lot de métriques peut porter cent instants
 * (un agent qui revient après une coupure), et évaluer dans le handler ferait
 * payer la détection au chemin le plus chaud du serveur. Les handlers d'agent se
 * contentent d'`enqueue()` ; le tour de boucle draine, **ne garde que le dernier
 * instant par appareil**, et évalue.
 *
 * ## Notifier aux transitions seulement
 *
 * Repris de `DatabaseMonitor`, et pour la même raison en plus aiguë : une
 * machine compromise déclenche vingt règles d'un coup. Renotifier à chaque tour
 * rendrait le canal inutilisable en une nuit, et les constats d'un même appareil
 * dans un même tour partent donc en **un seul message**.
 */

/** Cadence de vidage de la file. */
const TICK_SECONDS = env.SENTINEL_TICK_SECONDS;

/** Cadence de la passe lente : enveloppes, disparitions, balayage des résolus. */
const SLOW_PASS_MS = 60 * 60 * 1000;

/**
 * Plancher entre deux évaluations d'une même famille de règles, pour un même
 * appareil. Ces familles sont nourries par des relevés horaires, que l'agent
 * réémet aussi à la connexion : sans plancher, une machine qui se reconnecte en
 * boucle les faisait rejouer autant de fois.
 *
 * L'agent borne désormais son côté, mais ce plancher-ci reste nécessaire : il
 * prend effet sans attendre que la flotte se mette à jour, et couvre l'agent qui
 * *plante* en boucle, dont les jalons repartent à zéro. Dix minutes reste plus
 * réactif que la cadence horaire visée, donc rien n'est perdu en détection.
 * Détail dans `Docs/SENTINEL.md`.
 */
const EVAL_FLOOR_MS = 10 * 60 * 1000;

/**
 * Le délai est-il écoulé depuis la dernière fois ? `undefined` veut dire
 * « jamais », donc oui. Extrait pour être vérifiable sans horloge, et symétrique
 * de `due_at` côté agent : c'est la même décision, prise aux deux bouts.
 */
export function dueSince(lastMs: number | undefined, nowMs: number, floorMs: number): boolean {
    return lastMs === undefined || nowMs - lastMs >= floorMs;
}

/**
 * Dernière évaluation de chaque famille soumise au plancher. L'instant de
 * métriques n'y est pas : il est léger, arrive à la minute, et c'est lui qui
 * porte la détection réactive.
 */
type EvalMarks = { report?: number; auth?: number; integrity?: number };

/**
 * Combien d'instants d'absence avant de déclarer un programme disparu.
 *
 * Généreux exprès : un programme qui redémarre entre deux relevés ne doit pas
 * produire un constat. Dix instants valent dix minutes à la cadence par défaut.
 */
const VANISHED_AFTER_SAMPLES = 10;

/** Ancienneté minimale d'un programme avant qu'on juge sa disparition notable. */
const VANISHED_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;

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

export interface SecurityMonitorDeps {
    db: Db;
    /** Pour le chiffre « open » de l'espace : les canaux d'alerte y sont chiffrés. */
    crypt: Encryption;
    logger: Logger;
    audit: AuditLog;
    live?: LiveHub;
}

/** La ligne de base d'un appareil, telle que le moteur la tient en mémoire. */
interface BaselineCache {
    process: Map<string, BaselineRow>;
    listener: Map<string, BaselineRow>;
    persistence: Map<string, BaselineRow>;
}

/**
 * Mélange l'enveloppe connue et la mesure courante.
 *
 * Une vraie p95 exigerait de garder l'historique des mesures par programme, ce
 * qui coûterait plus cher que toute la détection. Cette moyenne mobile
 * exponentielle en tient lieu : elle monte lentement, redescend lentement, et
 * suffit à répondre à la seule question posée — « est-ce que ça sort largement
 * de l'ordinaire ? ». Le seuil de déclenchement (×3, et au moins 20 %) est
 * volontairement grossier pour la même raison.
 */
function blendP95(previous: number | null, sample: number): number {
    if (previous === null) return sample;
    // Une mesure au-dessus tire l'enveloppe vers le haut plus vite qu'une mesure
    // en dessous ne la fait redescendre : sinon une nuit calme abaisserait
    // l'enveloppe au point de faire sonner la reprise du matin.
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

export class SecurityMonitor {
    private timer: ReturnType<typeof setInterval> | null = null;
    /** Chiffres « open » par espace : le moteur n'a ni session ni mot de passe. */
    private readonly ciphers = new Map<number, Cipher>();
    private ticking = false;
    private lastSlowPass = 0;
    private readonly queue = new Map<string, Pending>();
    /**
     * La ligne de base, en mémoire.
     *
     * Sûr parce que ce moteur en est le **seul écrivain** et qu'il est un
     * singleton de processus (même hypothèse que `lastProcessSampleTs` dans
     * `agent/handlers/telemetry.ts`). Sans ce cache, chaque tour relirait trois
     * cents lignes par appareil, uniquement pour constater que rien n'a changé.
     * `invalidate()` est appelé par `sentinel.resetBaseline`.
     */
    private readonly baselines = new Map<string, BaselineCache>();
    /**
     * deviceId → dernière évaluation par famille, pour {@link EVAL_FLOOR_MS}.
     * Même forme et même durée de vie que `baselines` juste au-dessus.
     *
     * En mémoire volontairement : une perte au redémarrage n'autorise qu'une
     * évaluation de plus, ce qui est sans conséquence.
     */
    private readonly lastEval = new Map<string, EvalMarks>();

    constructor(private readonly deps: SecurityMonitorDeps) {}

    start(): void {
        if (this.timer) return;
        this.timer = setInterval(() => void this.tick(), TICK_SECONDS * 1000);
        this.timer.unref();
        this.deps.logger.info({ tickSeconds: TICK_SECONDS }, 'Security monitor started');
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

    /** Oublie la ligne de base en mémoire d'un appareil (après une remise à zéro). */
    invalidate(deviceId: string): void {
        this.baselines.delete(deviceId);
        // Une remise à zéro veut dire « reprends tout depuis rien » : garder le
        // plancher ferait attendre dix minutes la première évaluation qu'elle est
        // justement censée provoquer.
        this.lastEval.delete(deviceId);
    }

    /**
     * Réserve le droit d'évaluer une famille de règles pour cet appareil, ou le
     * refuse si le plancher n'est pas écoulé. Marque au passage : deux appels
     * rapprochés ne peuvent pas tous deux réussir.
     */
    private claimEvaluation(deviceId: string, kind: keyof EvalMarks, now: number): boolean {
        const marks = this.lastEval.get(deviceId) ?? {};
        if (!dueSince(marks[kind], now, EVAL_FLOOR_MS)) return false;
        marks[kind] = now;
        this.lastEval.set(deviceId, marks);
        return true;
    }

    // ─────────────────────────────── la file ─────────────────────────────────

    /** Un instant est arrivé. On note son `ts`, on n'évalue pas. */
    enqueueSnapshot(deviceId: string, ts: number): void {
        const pending = this.queue.get(deviceId) ?? {};
        // Le plus récent gagne : évaluer un instant déjà dépassé produirait des
        // constats sur un état qui n'existe plus.
        if (pending.snapshotTs === undefined || ts > pending.snapshotTs) pending.snapshotTs = ts;
        this.queue.set(deviceId, pending);
    }

    /** Un rapport est arrivé (posture, ports, connexions). */
    enqueueReport(deviceId: string): void {
        const pending = this.queue.get(deviceId) ?? {};
        pending.report = true;
        this.queue.set(deviceId, pending);
    }

    /**
     * Un manifeste de persistance est arrivé.
     *
     * Gardé **en entier** dans la file, et non relu depuis la base : on ne le
     * stocke jamais brut (c'est tout l'intérêt du diff), donc il n'existe qu'ici
     * entre sa réception et son évaluation. Un manifeste plus récent écrase le
     * précédent — le diff porte sur l'état courant.
     */
    enqueueIntegrity(deviceId: string, integrity: IntegrityReport): void {
        const pending = this.queue.get(deviceId) ?? {};
        pending.integrity = integrity;
        this.queue.set(deviceId, pending);
    }

    /**
     * Une fenêtre d'authentification est arrivée.
     *
     * Contrairement au manifeste, deux fenêtres consécutives ne s'écrasent pas :
     * elles se **fusionnent**. Une fenêtre est additive par nature, et en perdre
     * une reviendrait à perdre les tentatives qu'elle comptait — précisément ce
     * qu'on cherche à voir.
     */
    enqueueAuth(deviceId: string, auth: AuthWindow): void {
        const pending = this.queue.get(deviceId) ?? {};
        pending.auth = pending.auth ? mergeAuthWindows(pending.auth, auth) : auth;
        this.queue.set(deviceId, pending);
    }

    // ─────────────────────────────── la boucle ───────────────────────────────

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
                    // Un appareil qui échoue ne doit pas emporter les autres : sa
                    // file est déjà vidée, il repartira au prochain relevé.
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
            this.deps.db.baseline.known(deviceId, 'process'),
            this.deps.db.baseline.known(deviceId, 'listener'),
            this.deps.db.baseline.known(deviceId, 'persistence')
        ]);
        const fresh = { process, listener, persistence };
        this.baselines.set(deviceId, fresh);
        return fresh;
    }

    private async evaluate(deviceId: string, pending: Pending): Promise<void> {
        const device = await this.deps.db.devices.findById(deviceId);
        // Sentinelle éteinte, appareil archivé ou supprimé entre-temps : rien à
        // faire. Le garde est ici et pas seulement à l'ingestion parce qu'on peut
        // désactiver la feature pendant qu'une file attend.
        if (!device || device.sentinel_enabled !== 1 || device.status !== 'active') return;

        const now = Date.now();
        const learning = device.sentinel_learning_until !== null && now < Number(device.sentinel_learning_until);
        const baseline = await this.baselineOf(deviceId);

        const report = parseReport(device.report_json);
        const snapshot = pending.snapshotTs ? await this.loadSnapshot(deviceId, pending.snapshotTs) : null;

        const ctx: EvalContext = { now, learning, snapshot, report, baseline };

        const drafts: FindingDraft[] = [];
        // Chaque famille ne tourne que s'il y a de quoi la nourrir, et on note
        // laquelle a été rejouée : c'est ce qui autorise `record()` à résoudre
        // ses constats devenus muets. Sans ce garde, un simple manifeste de
        // persistance ferait re-résoudre tous les constats d'instant faute
        // d'instant à leur opposer.
        //
        // Instant et rapport sont distingués parce qu'ils arrivent à des
        // cadences différentes (60 s contre 1 h). Les confondre avait deux
        // effets, tous deux faux : la posture se re-constatait chaque minute sur
        // un rapport inchangé, et un rapport arrivé sans instant résolvait d'un
        // coup tous les constats `exec.*` / `net.*` / `process.*` — un détecteur
        // qui s'éteint sans bruit.
        const replayed: SentinelRuleId[] = [];
        if (snapshot !== null) {
            drafts.push(...evaluateSnapshot(ctx));
            replayed.push(...SNAPSHOT_RULES);
        }
        // Les trois familles périodiques passent par {@link EVAL_FLOOR_MS}. Le
        // `replayed` reste DANS le même bloc que son évaluation : l'annoncer sans
        // fournir de constats résoudrait la famille en bloc, soit le détecteur qui
        // s'éteint sans bruit décrit juste au-dessus. Seule la relecture des règles
        // est bornée, pas l'ingestion (écrite plus bas, inchangée).
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

        const opened = await this.record(device, drafts, replayed);

        // La ligne de base s'écrit **après** l'évaluation : l'inverse ferait
        // qu'un programme nouveau serait déjà connu au moment où on se demande
        // s'il est nouveau, et `process.new` ne se déclencherait jamais.
        if (snapshot) await this.observeSnapshot(deviceId, snapshot, baseline, now);
        if (report?.openPorts) await this.observeListeners(deviceId, report.openPorts, baseline, now);
        if (pending.integrity) {
            await this.observePersistence(deviceId, pending.integrity, baseline, now);
            await this.deps.db.devices.touchIntegrity(deviceId, pending.integrity.collectedAt);
        }

        if (opened.length > 0) await this.announce(device, opened);
    }

    /** L'instant, tel que les règles le veulent : métriques + liste des processus. */
    private async loadSnapshot(deviceId: string, ts: number): Promise<SnapshotView | null> {
        const sample = await this.deps.db.processSamples.nearest(deviceId, ts);
        const points = await this.deps.db.metrics.query({
            deviceId,
            from: ts - 1000,
            to: ts + 1000,
            resolution: 'raw'
        });
        const point = points[points.length - 1] ?? null;
        if (!sample && !point) return null;
        return {
            ts,
            processes: sample?.processes ?? [],
            activeConnections: point?.activeConnections ?? null
        };
    }

    // ───────────────────────────── les constats ──────────────────────────────

    /**
     * Confronte les constats produits à ceux en base, et rend ceux qui viennent
     * de s'ouvrir — les seuls qui méritent une notification.
     */
    private async record(
        device: DeviceRow,
        drafts: FindingDraft[],
        replayed: SentinelRuleId[]
    ): Promise<{ draft: FindingDraft; id: number }[]> {
        const now = Date.now();
        const workspaceId = device.workspace_id;
        // Les autorisations sont portées par l'espace ; un appareil orphelin
        // (son espace d'appairage a été supprimé) n'en a plus aucune à consulter.
        const allowed = workspaceId
            ? await this.deps.db.sentinelAllow.forDevice(workspaceId, device.id)
            : new Set<string>();

        const kept = drafts.filter((d) => !allowed.has(allowKey(d.rule, d.subject)));
        const opened: { draft: FindingDraft; id: number }[] = [];
        const seen: Buffer[] = [];

        for (const draft of kept) {
            const outcome = await this.deps.db.findings.upsert(device.id, draft, now);
            seen.push(findingDedup(draft.rule, draft.subject));
            if (outcome.isNew) opened.push({ draft, id: outcome.id });
        }

        // Ce qui ne se déclenche plus se résout — mais seulement pour les règles
        // qu'on vient effectivement de rejouer. Résoudre `persistence.*` parce
        // qu'un instant est passé dirait une chose fausse, et résoudre la posture
        // parce qu'un lot de métriques est arrivé dirait qu'un réglage a changé
        // sans que personne ne l'ait relu. `resolveMissing` filtre par jeu de
        // règles, donc `seen` peut rester l'union de tout ce qu'on a produit.
        if (replayed.length > 0) {
            await this.deps.db.findings.resolveMissing(device.id, replayed, seen, now);
        }

        // Épingler l'instant qui porte la preuve, pour les constats sérieux. Sans
        // cela la rétention effacerait, trente jours plus tard, la seule liste de
        // processus qui explique le constat.
        // `setInstantsPinned` épingle les deux tables en une seule instruction —
        // c'est justement ce qu'il faut ici : une preuve à moitié épinglée est
        // une preuve dont la liste de processus disparaît à la purge suivante.
        const toPin = [
            ...new Set(
                opened
                    .filter(
                        ({ draft }) => SEVERITY_RANK[draft.severity] >= SEVERITY_RANK.high && draft.snapshotTs !== null
                    )
                    .map(({ draft }) => draft.snapshotTs!)
            )
        ];
        for (const ts of toPin) {
            try {
                await this.deps.db.metrics.setInstantsPinned(device.id, ts, ts, true);
            } catch (e) {
                // Une preuve non épinglée reste un constat valide : on journalise
                // et on continue, plutôt que de perdre le constat lui-même.
                this.deps.logger.warn(
                    { deviceId: device.id, ts, err: e instanceof Error ? e.message : String(e) },
                    'Sentinel: could not pin evidence snapshot'
                );
            }
        }

        return opened;
    }

    // ──────────────────────── écriture de la ligne de base ───────────────────

    private async observeSnapshot(
        deviceId: string,
        snapshot: { ts: number; processes: ReportProcess[] },
        baseline: BaselineCache,
        at: number
    ): Promise<void> {
        if (snapshot.processes.length === 0) return;
        const items: BaselineObservation[] = [];

        for (const p of snapshot.processes) {
            const key = processKey(p);
            const known = baseline.process.get(key);
            const previous = attrsOf(known);
            // **Fusion, jamais remplacement.** `observe` écrit `attrs` en bloc :
            // écraser ferait qu'un programme tournant sous deux comptes
            // déclencherait `process.user_changed` à chaque alternance, et que
            // l'enveloppe serait recalculée depuis une seule mesure.
            const attrs: BaselineAttrs = {
                ...previous,
                users: mergeList(previous.users, p.user, 16),
                listenPorts: mergePorts(previous.listenPorts, p.listenPorts, 64),
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

        await this.deps.db.baseline.observe(deviceId, at, items);
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
        if (items.length > 0) await this.deps.db.baseline.observe(deviceId, at, items);
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
        // `persistence.removed`. Un manifeste tronqué ne prouve rien, on n'y
        // touche pas (même raison que dans `persistenceRules`).
        if (!integrity.truncated) {
            const present = new Set(integrity.entries.map((e) => e.path));
            const gone = [...baseline.persistence.keys()].filter((path) => !present.has(path));
            if (gone.length > 0) {
                await this.deps.db.baseline.forget(deviceId, 'persistence', gone);
                for (const path of gone) baseline.persistence.delete(path);
            }
        }

        if (items.length === 0) return;
        await this.deps.db.baseline.observe(deviceId, at, items);
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

    // ─────────────────────────────── passe lente ─────────────────────────────

    /**
     * Ce qui ne se décide pas sur un instant : les programmes disparus, et le
     * balayage des constats résolus.
     */
    private async slowPass(): Promise<void> {
        const devices = await this.deps.db.devices.listSentinelEnabled();
        const now = Date.now();

        for (const device of devices) {
            if (device.sentinel_learning_until !== null && now < Number(device.sentinel_learning_until)) continue;
            const interval = (device.metric_interval_seconds ?? 60) * 1000;
            const stale = await this.deps.db.baseline.staleSince(
                device.id,
                'process',
                now - VANISHED_AFTER_SAMPLES * interval
            );
            const drafts: FindingDraft[] = stale
                // Un programme aperçu trois fois la semaine dernière n'a pas
                // « disparu » : il n'était pas installé, il passait.
                .filter((row) => now - row.first_seen >= VANISHED_MIN_AGE_MS && row.samples >= 500)
                .map((row) => ({
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

            if (drafts.length === 0) continue;
            // Aucune famille rejouée : `process.vanished` se constate par absence
            // et n'a rien à résoudre — c'est le retour du programme qui le ferme,
            // pas ce balayage.
            const opened = await this.record(device, drafts, []);
            if (opened.length > 0) await this.announce(device, opened);
        }

        const pruned = await this.deps.db.findings.pruneResolved(env.SENTINEL_FINDING_RETENTION_DAYS);
        if (pruned > 0) this.deps.logger.info({ pruned }, 'Sentinel: resolved findings pruned');
    }

    // ─────────────────────────────── notification ────────────────────────────

    /**
     * Journalise, réveille les vues, et notifie si ça le mérite.
     *
     * Le groupage est la partie qui compte : les constats d'un même appareil dans
     * un même tour partent en un seul message. Vingt mails simultanés ne se
     * lisent pas, et la première réaction de qui les reçoit est de créer une
     * règle de filtrage.
     */
    private async announce(device: DeviceRow, opened: { draft: FindingDraft; id: number }[]): Promise<void> {
        for (const { draft } of opened) {
            this.deps.audit.record({
                level: SEVERITY_RANK[draft.severity] >= SEVERITY_RANK.high ? 'warning' : 'info',
                source: 'system',
                category: 'sentinel',
                action: draft.rule,
                // Le moteur n'a pas d'acteur : il tourne sans session. On
                // attribue au propriétaire de l'appareil, comme le fait
                // `UptimeMonitor` avec `row.user_id`.
                uid: device.owner_id,
                ip: '',
                description: `${SENTINEL_RULES[draft.rule].label} sur « ${device.name} » : ${draft.subject}`,
                metadata: { deviceId: device.id, rule: draft.rule, subject: draft.subject }
            });
        }

        if (device.workspace_id) this.deps.live?.changed(device.workspace_id, ['sentinel'], null);

        const notifiable = opened.filter(({ draft }) => SEVERITY_RANK[draft.severity] >= SEVERITY_RANK.high);
        if (notifiable.length === 0 || !device.workspace_id) return;

        const worst = notifiable.reduce(
            (acc, { draft }) => (SEVERITY_RANK[draft.severity] > SEVERITY_RANK[acc] ? draft.severity : acc),
            'high' as FindingSeverity
        );
        const lines = notifiable.map(
            ({ draft }) => `• [${draft.severity}] ${SENTINEL_RULES[draft.rule].label} — ${draft.subject}`
        );
        // La règle du constat le plus grave donne son titre à l'embed : dans un
        // salon de sécurité, ce qu'on doit lire en premier est *ce qui a été
        // enfreint*, pas le nombre de lignes ouvertes.
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

        await this.notify(device.workspace_id, {
            deviceName: device.name,
            severity: worst,
            count: notifiable.length,
            body,
            at: Math.floor(Date.now() / 1000),
            rule: SENTINEL_RULES[lead.draft.rule].label,
            remediation: SENTINEL_RULES[lead.draft.rule].remediation
        });
        await this.deps.db.findings.markNotified(notifiable.map((n) => n.id));
    }

    /**
     * Délivre sur les canaux de l'espace — ceux d'Uptime, comme `DatabaseMonitor`.
     *
     * Toute erreur est journalisée puis avalée : un webhook en panne ne doit ni
     * supprimer le mail, ni arrêter la boucle.
     */
    /**
     * Délivre sur les canaux **de Sentinelle**.
     *
     * Ses propres réglages, et non ceux d'Uptime : une alerte de sécurité n'a ni
     * les mêmes destinataires ni la même urgence qu'une alerte de disponibilité,
     * et emprunter un canal qu'on n'a pas désigné pour ça revient à écrire à des
     * gens sans le leur avoir demandé. Sans réglage enregistré, rien ne part.
     */
    private async notify(
        workspaceId: number,
        alert: {
            deviceName: string;
            severity: FindingSeverity;
            count: number;
            body: string;
            at: number;
            /** L'intitulé de la règle du constat le plus grave — le titre de l'embed. */
            rule: string;
            /** Ce que cette règle propose de faire, quand elle porte une remédiation. */
            remediation: string | null;
        }
    ): Promise<void> {
        const channels = await resolveRoute(this.deps.db, this.cipherFor(workspaceId), workspaceId, 'sentinel');
        if (!hasChannel(channels)) return;

        await deliver(
            channels,
            {
                subject: `[DevEye] Sentinelle ${alert.severity} — ${alert.deviceName}`,
                body: alert.body,
                payload: {
                    event: 'sentinel_finding',
                    device: alert.deviceName,
                    severity: alert.severity,
                    count: alert.count,
                    at: alert.at
                },
                // La même alerte, mise en page pour Discord. Sentinelle n'en
                // avait pas, faute d'avoir été écrite — c'est pourtant
                // l'émetteur où la gravité doit se lire avant le texte.
                embeds: buildNotice({
                    device: alert.deviceName,
                    rule: alert.rule,
                    severity: alert.severity === 'critical' ? 'critical' : alert.severity === 'high' ? 'high' : 'low',
                    detail: alert.body,
                    remediation: alert.remediation,
                    at: alert.at
                })
            },
            this.deps.logger
        );
    }
}

/** Un rapport illisible vaut « pas de rapport », jamais une exception. */
function parseReport(raw: string | null): DeviceReport | null {
    if (!raw) return null;
    try {
        return JSON.parse(raw) as DeviceReport;
    } catch {
        return null;
    }
}

/**
 * Fusionne deux fenêtres d'authentification consécutives.
 *
 * Les compteurs s'additionnent, les bornes s'élargissent, les adresses se
 * regroupent. `unavailable` est vrai dès qu'une des deux l'était : si une moitié
 * de la période n'a pas pu être lue, on ne peut pas prétendre avoir tout vu.
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
        unavailable: a.unavailable || b.unavailable
    };
}
