import {
    APPSTORES_ANR_THRESHOLD,
    APPSTORES_BACKFILL_DAYS,
    APPSTORES_CRASH_THRESHOLD,
    APPSTORES_REVIEWS_KEEP_DAYS,
    APPSTORES_REVIEWS_MAX_PER_STORE,
    APPSTORES_VITALS_WINDOW_DAYS,
    isStoreAppId,
    type AppStoresCapability,
    type AppStoresVersion
} from '../contracts/domain';
import {
    isRemoteFailure,
    logFailure,
    type DevEyeFacade,
    type FeatureService,
    type FeatureServiceDeps,
    type SdkCipher,
    type SdkTask
} from '@deveye/types/sdk/server';

import { DAY_SECONDS, monthBounds, monthsDescending, pacificToday, utcToday } from './days';
import { phaseOf, reviewsNotice, sourceNotice, versionNotice, vitalsNotice, type VersionPhase } from './notice';
import { decodeText } from './parse/csv';
import { ArchiveError, unzipFirst } from './parse/unzip';
import type { AppStoresRepo, ListingRow, SourceRow } from './repo';
import { figuresFor, firstReviewsPage, skuOf, type AppleSalesReport } from './stores/apple';
import {
    countriesObject,
    installsObject,
    parseCountryInstalls,
    parseInstalls,
    parseRatings,
    parseSales,
    ratingsObject,
    salesObject,
    type VitalsDay
} from './stores/google';
import { openCredentials, STORE_CLIENTS, type StoreClients, type StoreCredentials } from './stores/index';
import { isAbort, StoreError, type StoreReview } from './stores/types';
import {
    capabilitiesOf,
    LOST_AFTER_REFUSALS,
    readApp,
    readJson,
    readSource,
    reviewRef,
    sealJson,
    type ListingState,
    type StoredListing,
    type StoredReview
} from './_shared';

/**
 * La synchronisation des stores, en tâche de fond. Un battement par minute
 * choisit les fiches dues et lance une passe par source, jamais deux à la
 * fois pour la même : un rapport de ventes d'Apple sert toutes les apps d'un
 * compte, il se lit donc une fois par source et se répartit entre ses apps.
 *
 * Tout se lit et s'écrit à l'étage ouvert, sans session. Une erreur de store
 * s'attrape dans la passe ; un battement qui lève reste une panne de l'instance.
 */

const TICK_MS = 60_000;
/** Les chiffres du jour, les avis et versions, la note Apple. */
const METRICS_EVERY = 6 * 3600;
const REVIEWS_EVERY = 30 * 60;
const RATING_EVERY = 24 * 3600;
/** Passes en même temps, tout le serveur confondu. */
const MAX_PASSES = 4;
const DUE_LIMIT = 100;
/** Le repli d'une source : 60 s doublées à chaque échec, plafonnées à 15 min. */
const BACKOFF_MIN = 60;
const BACKOFF_MAX = 15 * 60;
/** Ce qu'une passe lit au plus : un rattrapage d'un an se fait en plusieurs passes, curseurs en base. */
const APPLE_REPORTS_PER_PASS = 30;
const GOOGLE_OBJECTS_PER_PASS = 30;
const REVIEW_PAGES_PER_PASS = 10;
/** Les dernières versions gardées par fiche de store. */
const VERSIONS_KEPT = 5;
/** Une réponse Apple de moins de deux semaines peut encore attendre sa relecture. */
const PENDING_REPLY_SECONDS = 14 * DAY_SECONDS;
/** Les jours de stabilité relus, de quoi couvrir la moyenne sur 28 jours. */
const VITALS_DAYS = APPSTORES_VITALS_WINDOW_DAYS + 7;
const OBJECT_MAX_BYTES = 64 * 1024 * 1024;
const SALES_MAX_OUTPUT = 256 * 1024 * 1024;
/** `sync_error` et `failing_error` tiennent en 300 caractères. */
const SENTENCE_MAX = 300;

/** Les rapports mensuels d'un paquet que lit une passe : leur dossier du bucket, et le nom d'un mois. */
const GOOGLE_REPORTS = {
    installs: { what: 'les installations', folder: 'installs', object: installsObject },
    countries: { what: 'les installations par pays', folder: 'installs', object: countriesObject },
    ratings: { what: 'les notes', folder: 'ratings', object: ratingsObject }
} as const;
type GoogleReport = keyof typeof GOOGLE_REPORTS;

const PAUSED = 'Cette app est en pause : l’offre de son propriétaire est atteinte.';
const NO_SOURCE = 'Aucune fiche de cette app n’a de source : choisissez-en une dans ses réglages.';
const BACKING_OFF =
    'Le store a refusé ou laissé sans réponse le dernier essai de cette clé : la synchronisation reprendra d’elle-même dans quelques minutes.';
const UNREADABLE = 'L’identité de cette fiche ne se lit plus : retirez-la puis reliez l’app de nouveau.';
const STOPPED = 'La synchronisation s’est interrompue : le service de Stores s’est arrêté.';

/** Qui a demandé une synchronisation : sa zone des opérations la suit. */
export interface SyncLauncher {
    userId: number;
    workspaceId: number;
    subject: string;
}

interface Forced {
    task: SdkTask | null;
    /** Les sources qu'il reste à passer ; `null` tant que le battement ne les a pas lues. */
    sources: Set<number> | null;
    errors: string[];
}

/** Une fiche pendant une passe : ce qu'on en a lu, et ce que la passe va en écrire. */
interface Work {
    row: ListingRow;
    appName: string;
    ratingCountry: string;
    content: StoredListing;
    contentChanged: boolean;
    state: ListingState;
    syncedDay: number | null;
    historyFrom: number | null;
    forced: boolean;
    metricsAt: number | null;
    reviewsAt: number | null;
    ratingAt: number | null;
    error: string | null;
    touched: boolean;
    changed: boolean;
    newReviews: StoreReview[];
    versionNotices: { version: string; phase: VersionPhase }[];
    vitalsNotices: { metric: 'crash' | 'anr'; over: boolean; rate: number }[];
}

interface Pass {
    source: SourceRow;
    label: string;
    credentials: StoreCredentials;
    capabilities: Set<AppStoresCapability>;
    /** Appels réussis avec la clé : au moins un, et la clé tient. */
    ok: number;
    refused: StoreError | null;
    /** Un 401 : plus rien ne passera avec cette clé dans cette passe. */
    keyRefused: boolean;
    rateLimited: StoreError | null;
    failed: unknown;
    interrupted: boolean;
    changed: boolean;
}

type Attempt<T> = { value: T } | { failure: 'refused' | 'transient' };

const failed = <T>(attempt: Attempt<T>): attempt is { failure: 'refused' | 'transient' } => 'failure' in attempt;

const STORE_OWNER = { apple: 'Apple', google: 'Google' } as const;

/** Notre phrase pour un échec, jamais celle du store. */
function failureSentence(e: StoreError, label: string, what: string): string {
    const who = STORE_OWNER[e.store];
    if (e.status === 401) return `${who} refuse la clé « ${label} » : elle a pu être révoquée ou supprimée.`;
    if (e.status === 403) {
        return e.store === 'apple'
            ? `La clé « ${label} » ne lit pas ${what} : son rôle dans App Store Connect ne le permet pas.`
            : `Le compte de service « ${label} » ne lit pas ${what} : la Play Console ne lui en donne pas la permission.`;
    }
    if (e.status === 404) return `${who} ne trouve pas ${what} de cette app avec la clé « ${label} ».`;
    if (e.status === 429)
        return `${who} limite les appels de la clé « ${label} » : nouvel essai dans quelques minutes.`;
    if (e.status === 0 || e.status >= 500) return `${who} ne répond pas : nouvel essai dans quelques minutes.`;
    return e.message;
}

/** Les taux moyens d'une fenêtre, pondérés par les utilisateurs de chaque jour. */
export function weightedRate(days: readonly VitalsDay[], metric: 'crashRate' | 'anrRate'): number | null {
    let sum = 0;
    let weight = 0;
    for (const day of days) {
        const rate = day[metric];
        if (rate === null) continue;
        const users = day.users !== null && day.users > 0 ? day.users : 1;
        sum += rate * users;
        weight += users;
    }
    return weight > 0 ? sum / weight : null;
}

function sameReview(a: StoredReview, b: StoredReview): boolean {
    return (
        a.title === b.title &&
        a.body === b.body &&
        a.author === b.author &&
        a.territory === b.territory &&
        a.appVersion === b.appVersion &&
        (a.reply?.body ?? null) === (b.reply?.body ?? null) &&
        (a.reply?.state ?? null) === (b.reply?.state ?? null) &&
        (a.reply?.responseId ?? null) === (b.reply?.responseId ?? null)
    );
}

export function storedReviewOf(review: StoreReview): StoredReview {
    return {
        externalId: review.externalId,
        title: review.title,
        body: review.body,
        author: review.author,
        territory: review.territory,
        appVersion: review.appVersion,
        reply: review.reply
    };
}

/**
 * L'avis d'une clé refusée ou de nouveau acceptée : un seul par source, vers
 * l'union des canaux de ses apps. `true` si un canal au moins l'a accepté.
 */
export async function announceSource(
    repo: AppStoresRepo,
    cipher: SdkCipher,
    notify: DevEyeFacade['notify'],
    source: SourceRow,
    state: { lost: boolean; cause: string; at: number }
): Promise<boolean> {
    const appIds = await repo.listAppIdsOfSource(source.id);
    if (appIds.length === 0) return false;
    const apps = await repo.listAppsByIds(appIds);
    const names = await Promise.all(apps.map(async (app) => (await readApp(cipher, app)).name || `App ${app.id}`));
    const stored = await readSource(cipher, source);
    const alert = sourceNotice({ ...state, store: source.store, label: stored.label || 'sans nom', apps: names });
    return notify.send(alert, { itemIds: appIds });
}

/**
 * Le rattrapage d'un an repart, sans rien effacer : Apple relit ses rapports
 * du dernier jour relevé vers le passé, Google ses mois, `etag` oubliés.
 */
function rewind(state: ListingState, row: ListingRow): ListingState {
    const next: ListingState = { ...state, backfillDone: false, etags: {} };
    delete next.backfillFrom;
    delete next.backfillAt;
    if (row.store === 'apple' && row.synced_day !== null) next.backfillAt = row.synced_day;
    return next;
}

export class AppStoresSync {
    private readonly ticker: FeatureService;
    private ticking: Promise<void> | null = null;
    /** Une passe à la fois par source ; `stop()` les attend toutes. */
    private readonly passes = new Map<number, Promise<void>>();
    /** Les apps qu'une passe tient : une autre passe les laisse pour le battement suivant. */
    private readonly inFlight = new Set<number>();
    /** Les sources en repli, jusqu'à `notBefore` (secondes epoch). */
    private readonly backoff = new Map<number, { notBefore: number; delay: number }>();
    /** Les apps dont un membre a demandé la synchronisation. */
    private readonly forced = new Map<number, Forced>();
    private controller = new AbortController();
    private stopping = true;
    private purgedDay: number | null = null;

    constructor(
        private readonly deps: FeatureServiceDeps<AppStoresRepo>,
        private readonly clients: StoreClients = STORE_CLIENTS,
        private readonly clock: () => number = () => Date.now()
    ) {
        this.ticker = deps.createTicker({ intervalMs: TICK_MS, tick: () => this.tick() });
    }

    start(): void {
        this.stopping = false;
        this.controller = new AbortController();
        void this.ticker.start();
        this.wake();
    }

    /** Rend la main une fois chaque passe finie ou interrompue ; un `start()` suivant repart de zéro. */
    async stop(): Promise<void> {
        this.stopping = true;
        this.controller.abort();
        await this.ticker.stop();
        await this.idle();
        for (const forced of this.forced.values()) forced.task?.fail(STOPPED, 'conflict');
        this.forced.clear();
        this.inFlight.clear();
    }

    /** Attend le battement en cours et chaque passe en vol, y compris celles qu'une fin de passe relance. */
    async idle(): Promise<void> {
        while (this.ticking !== null || this.passes.size > 0) {
            await this.ticking?.catch(() => undefined);
            await Promise.allSettled([...this.passes.values()]);
        }
    }

    /** Un battement hors cadence, après une écriture qui change ce qui est dû. */
    wake(): void {
        if (this.stopping) return;
        void this.tick().catch((e: unknown) => this.deps.logger.error({ err: e }, 'Stores : battement en échec'));
    }

    /**
     * Relit l'année écoulée d'une app, cadences ignorées : la première passe
     * relance le rattrapage, les battements suivants le finissent. Avec un
     * `launcher`, l'opération paraît dans sa zone jusqu'à la fin de cette passe.
     */
    requestBackfill(appId: number, launcher: SyncLauncher | null): void {
        if (this.stopping) return;
        const existing = this.forced.get(appId);
        const task =
            existing?.task ??
            (launcher
                ? this.deps.tasks.open({
                      userId: launcher.userId,
                      workspaceId: launcher.workspaceId,
                      itemId: appId,
                      key: 'sync',
                      title: 'Relecture de l’année écoulée',
                      subject: launcher.subject
                  })
                : null);
        this.forced.set(appId, { task, sources: existing?.sources ?? null, errors: existing?.errors ?? [] });
        this.wake();
    }

    private get signal(): AbortSignal {
        return this.controller.signal;
    }

    private nowSeconds(): number {
        return Math.floor(this.clock() / 1000);
    }

    private tick(): Promise<void> {
        this.ticking ??= this.runTick().finally(() => {
            this.ticking = null;
        });
        return this.ticking;
    }

    private async runTick(): Promise<void> {
        if (this.stopping) return;
        const now = this.nowSeconds();
        await this.purge();
        await this.resolveForced();
        if (this.passes.size >= MAX_PASSES) return;

        const backingOff = [...this.backoff].filter(([, b]) => b.notBefore > now).map(([id]) => id);
        this.releaseBackedOff(new Set(backingOff));
        const skip = new Set([...this.passes.keys(), ...backingOff]);
        const order: number[] = [];
        for (const [appId, forced] of this.forced) {
            // Une app qu'une autre passe tient attend sa fin, qui relance le battement.
            if (this.inFlight.has(appId)) continue;
            for (const sourceId of forced.sources ?? []) {
                if (!skip.has(sourceId) && !order.includes(sourceId)) order.push(sourceId);
            }
        }
        const due = await this.deps.repo.listDue({
            metricsBefore: now - METRICS_EVERY,
            reviewsBefore: now - REVIEWS_EVERY,
            ratingBefore: now - RATING_EVERY,
            pausedAppIds: this.deps.pauses
                .paused('apps')
                .map(Number)
                .filter((id) => Number.isInteger(id)),
            skipSourceIds: [...skip],
            limit: DUE_LIMIT
        });
        for (const row of due) if (!order.includes(row.source_id)) order.push(row.source_id);
        if (this.stopping) return;
        for (const sourceId of order.slice(0, MAX_PASSES - this.passes.size)) this.launch(sourceId);
    }

    /**
     * Les avis de plus d'un an, et au-delà du plafond par app et par store,
     * partent une fois par jour, avec les pays plus anciens que le rattrapage.
     */
    private async purge(): Promise<void> {
        const today = utcToday(this.clock());
        if (this.purgedDay === today) return;
        const cutoff = this.nowSeconds() - APPSTORES_REVIEWS_KEEP_DAYS * DAY_SECONDS;
        let removed = 0;
        for (let round = 0; round < 20; round++) {
            const count = await this.deps.repo.purgeReviewsBefore(cutoff);
            removed += count;
            if (count < 5000) break;
        }
        for (const { app_id, store } of await this.deps.repo.overflowingReviews(APPSTORES_REVIEWS_MAX_PER_STORE)) {
            removed += await this.deps.repo.trimReviews(app_id, store, APPSTORES_REVIEWS_MAX_PER_STORE);
        }
        let countries = 0;
        for (let round = 0; round < 20; round++) {
            const count = await this.deps.repo.purgeCountriesBefore(today - APPSTORES_BACKFILL_DAYS);
            countries += count;
            if (count < 5000) break;
        }
        this.purgedDay = today;
        if (removed + countries > 0) {
            this.deps.logger.info({ reviews: removed, countries }, 'Stores : relevés anciens retirés');
        }
    }

    /** Les sources d'une synchronisation demandée, lues une fois. */
    private async resolveForced(): Promise<void> {
        const pending = [...this.forced].filter(([, f]) => f.sources === null).map(([appId]) => appId);
        if (pending.length === 0) return;
        const listings = await this.deps.repo.listListingsOfApps(pending);
        for (const appId of pending) {
            const forced = this.forced.get(appId);
            if (!forced) continue;
            const sources = new Set(
                listings.flatMap((l) => (l.app_id === appId && l.source_id !== null ? [l.source_id] : []))
            );
            if (this.deps.pauses.isPaused('apps', String(appId))) this.finishForced(appId, PAUSED);
            else if (sources.size === 0) this.finishForced(appId, NO_SOURCE);
            else forced.sources = sources;
        }
    }

    /** Une synchronisation demandée sur une source en repli ne l'attend pas : elle le dit. */
    private releaseBackedOff(backingOff: ReadonlySet<number>): void {
        for (const [appId, forced] of [...this.forced]) {
            if (!forced.sources) continue;
            for (const sourceId of [...forced.sources]) {
                if (!backingOff.has(sourceId)) continue;
                forced.sources.delete(sourceId);
                forced.errors.push(BACKING_OFF);
            }
            if (forced.sources.size === 0) this.finishForced(appId);
        }
    }

    private finishForced(appId: number, error?: string): void {
        const forced = this.forced.get(appId);
        if (!forced) return;
        this.forced.delete(appId);
        const failure = error ?? forced.errors[0];
        if (failure === undefined) {
            forced.task?.done('Relecture lancée : les mois restants se complètent d’eux-mêmes en quelques minutes.');
        } else forced.task?.fail(failure, 'conflict');
    }

    private launch(sourceId: number): void {
        const run = this.runPass(sourceId)
            .catch((e: unknown) => {
                this.deps.logger.error({ err: e, sourceId }, 'Stores : passe en échec');
                this.bumpBackoff(sourceId, null);
                for (const [appId, forced] of [...this.forced]) {
                    if (forced.sources?.delete(sourceId) && forced.sources.size === 0) {
                        this.finishForced(appId, 'La synchronisation a échoué.');
                    }
                }
            })
            .finally(() => {
                this.passes.delete(sourceId);
                if (this.forcedWaiting()) this.wake();
            });
        this.passes.set(sourceId, run);
    }

    /** Une synchronisation demandée qu'aucune passe ne tient ni ne retient : un battement la prendra tout de suite. */
    private forcedWaiting(): boolean {
        return [...this.forced].some(
            ([appId, forced]) =>
                !this.inFlight.has(appId) && [...(forced.sources ?? [])].some((s) => !this.passes.has(s))
        );
    }

    private bumpBackoff(sourceId: number, retryAt: number | null): void {
        const previous = this.backoff.get(sourceId);
        const delay = previous ? Math.min(previous.delay * 2, BACKOFF_MAX) : BACKOFF_MIN;
        this.backoff.set(sourceId, { notBefore: Math.max(this.nowSeconds() + delay, retryAt ?? 0), delay });
    }

    private halted(pass: Pass): boolean {
        return this.stopping || pass.interrupted || pass.keyRefused || pass.rateLimited !== null;
    }

    /**
     * Un appel de la passe. L'échec est classé et attribué aux fiches qu'il
     * concerne, jamais levé, sauf ce qui n'est pas une erreur de store.
     * `keyless` : un appel sans la clé (la note publique), dont l'échec ne dit
     * rien de la source et ne la fait pas reculer : il se journalise, seul.
     */
    private async attempt<T>(
        pass: Pass,
        works: Work | readonly Work[],
        what: string,
        run: () => Promise<T>,
        keyless = false
    ): Promise<Attempt<T>> {
        if (this.halted(pass)) return { failure: 'transient' };
        const concerned = Array.isArray(works) ? works : [works as Work];
        try {
            const value = await run();
            if (!keyless) pass.ok += 1;
            return { value };
        } catch (raw) {
            if (isAbort(raw) && this.stopping) {
                pass.interrupted = true;
                return { failure: 'transient' };
            }
            const e =
                raw instanceof ArchiveError
                    ? new StoreError(pass.source.store, 200, {
                          message: 'Un rapport du store ne s’ouvre pas : il sera relu plus tard.',
                          cause: raw
                      })
                    : raw;
            if (!(e instanceof StoreError)) throw e;
            if (keyless) {
                logFailure(
                    this.deps.logger,
                    isRemoteFailure(e.cause ?? e) || (e.status >= 400 && e.status < 500),
                    { sourceId: pass.source.id, status: e.status, detail: e.detail },
                    `Stores : ${what} ne se lit pas`
                );
                return { failure: 'transient' };
            }
            const sentence = failureSentence(e, pass.label, what).slice(0, SENTENCE_MAX);
            for (const work of concerned) work.error ??= sentence;
            if (e.refused) {
                pass.refused ??= e;
                if (e.status === 401) pass.keyRefused = true;
                return { failure: 'refused' };
            }
            if (e.rateLimited) pass.rateLimited ??= e;
            else pass.failed ??= e;
            return { failure: 'transient' };
        }
    }

    private async runPass(sourceId: number): Promise<void> {
        const source = await this.deps.repo.findSourceById(sourceId);
        const forcedHere = [...this.forced].filter(([, f]) => f.sources?.has(sourceId)).map(([appId]) => appId);
        const release = (appIds: readonly number[], errors: ReadonlyMap<number, string | null> = new Map()) => {
            for (const appId of appIds) {
                const forced = this.forced.get(appId);
                if (!forced?.sources?.delete(sourceId)) continue;
                const error = errors.get(appId);
                if (error) forced.errors.push(error);
                if (forced.sources.size === 0) this.finishForced(appId);
            }
        };
        if (!source) {
            release(forcedHere);
            return;
        }
        const cipher = this.deps.cipherFor(source.workspace_id);
        const opened = await openCredentials(cipher, source);
        if (!opened) {
            this.deps.logger.error({ sourceId }, 'Stores : les clés d’une source ne se déchiffrent plus');
            this.bumpBackoff(sourceId, null);
            release(forcedHere, new Map(forcedHere.map((id) => [id, 'Les clés de cette source ne se lisent plus.'])));
            return;
        }

        const all = await this.deps.repo.listListingsOfSource(sourceId);
        release(forcedHere.filter((appId) => !all.some((row) => row.app_id === appId)));
        const paused = (appId: number) => this.deps.pauses.isPaused('apps', String(appId));
        release(forcedHere.filter(paused), new Map(forcedHere.map((id) => [id, PAUSED])));
        const rows = all.filter((row) => !this.inFlight.has(row.app_id) && !paused(row.app_id));
        if (rows.length === 0) return;
        for (const row of rows) this.inFlight.add(row.app_id);

        const pass: Pass = {
            source,
            label: opened.content.label || 'sans nom',
            credentials: opened.credentials,
            capabilities: new Set(capabilitiesOf(source.capabilities)),
            ok: 0,
            refused: null,
            keyRefused: false,
            rateLimited: null,
            failed: null,
            interrupted: false,
            changed: false
        };
        let works: Work[] = [];
        try {
            works = await this.openWorks(cipher, rows, new Set(forcedHere));
            const readable = new Set(works.map((w) => w.row.app_id));
            const unreadable = rows.map((r) => r.app_id).filter((appId) => !readable.has(appId));
            release(unreadable, new Map(unreadable.map((id) => [id, UNREADABLE])));
            await this.metrics(pass, works);
            for (const work of works) {
                if (this.halted(pass)) break;
                if (paused(work.row.app_id)) continue;
                await this.listingSteps(pass, cipher, work);
            }
        } finally {
            try {
                await this.finish(pass, cipher, works);
            } finally {
                for (const row of rows) this.inFlight.delete(row.app_id);
                const touched = works.filter((w) => w.touched);
                release(
                    forcedHere.filter((appId) => touched.some((w) => w.row.app_id === appId)),
                    new Map(touched.map((w) => [w.row.app_id, w.error]))
                );
            }
        }
    }

    private async openWorks(
        cipher: SdkCipher,
        rows: readonly ListingRow[],
        forced: ReadonlySet<number>
    ): Promise<Work[]> {
        const apps = new Map(
            (await this.deps.repo.listAppsByIds([...new Set(rows.map((r) => r.app_id))])).map((a) => [a.id, a])
        );
        const works: Work[] = [];
        for (const row of rows) {
            const app = apps.get(row.app_id);
            if (!app) continue;
            const stored = await readApp(cipher, app);
            const content = await readJson<Partial<StoredListing>>(cipher, row.content);
            if (!content?.externalId || !isStoreAppId(row.store, content.externalId)) {
                this.deps.logger.error({ listingId: row.id }, 'Stores : l’identité d’une fiche ne se lit plus');
                continue;
            }
            let state = (await readJson<ListingState>(cipher, row.state)) ?? {};
            if (forced.has(row.app_id)) {
                state = rewind(state, row);
                // Dus à chaque battement jusqu'à la fin du rattrapage, comme au premier branchement.
                await this.deps.repo.clearMetricsSync(row.id);
            }
            works.push({
                row: forced.has(row.app_id) ? { ...row, metrics_synced_at: null } : row,
                appName: stored.name || `App ${row.app_id}`,
                ratingCountry: stored.ratingCountry,
                content: {
                    externalId: content.externalId,
                    storeName: content.storeName ?? null,
                    bundleId: content.bundleId ?? null,
                    sku: content.sku ?? null
                },
                contentChanged: false,
                state,
                syncedDay: row.synced_day,
                historyFrom: row.history_from,
                forced: forced.has(row.app_id),
                metricsAt: null,
                reviewsAt: null,
                ratingAt: null,
                error: null,
                touched: false,
                changed: false,
                newReviews: [],
                versionNotices: [],
                vitalsNotices: []
            });
        }
        return works;
    }

    private due(work: Work, column: number | null, every: number): boolean {
        return work.forced || column === null || column <= this.nowSeconds() - every;
    }

    private async persist(cipher: SdkCipher, work: Work): Promise<void> {
        await this.deps.repo.saveListing(work.row.id, {
            content: work.contentChanged ? await sealJson(cipher, work.content) : null,
            state: await sealJson(cipher, work.state),
            syncedDay: work.syncedDay,
            historyFrom: work.historyFrom,
            metricsSyncedAt: work.metricsAt,
            reviewsSyncedAt: work.reviewsAt,
            ratingSyncedAt: work.ratingAt,
            lastSyncAt: this.nowSeconds(),
            syncError: work.error
        });
        work.contentChanged = false;
    }

    // ------------------------------------------------------------- les chiffres du jour

    private async metrics(pass: Pass, works: readonly Work[]): Promise<void> {
        const due = works.filter((w) => this.due(w, w.row.metrics_synced_at, METRICS_EVERY));
        if (due.length === 0) return;
        for (const work of due) work.touched = true;
        if (pass.credentials.store === 'apple') await this.appleMetrics(pass, due);
        else await this.googleMetrics(pass, due);
    }

    private async appleMetrics(pass: Pass, works: readonly Work[]): Promise<void> {
        if (pass.credentials.store !== 'apple') return;
        const { creds } = pass.credentials;
        const now = this.nowSeconds();
        if (!pass.capabilities.has('downloads') && !pass.capabilities.has('revenue')) {
            for (const work of works) work.metricsAt = now;
            return;
        }

        if (pass.capabilities.has('apps')) {
            for (const work of works.filter((w) => w.content.sku === null || w.content.storeName === null)) {
                const found = await this.attempt(pass, work, 'cette app', () =>
                    this.clients.apple.fetchApp(creds, work.content.externalId, this.signal)
                );
                if (failed(found)) continue;
                if (found.value === null) {
                    work.error ??= `Apple ne connaît pas cette app avec la clé « ${pass.label} ».`;
                    continue;
                }
                work.content = {
                    ...work.content,
                    storeName: found.value.name,
                    bundleId: found.value.bundleId,
                    sku: found.value.sku ?? work.content.sku
                };
                work.contentChanged = true;
                work.changed = true;
            }
        }

        const latest = pacificToday(this.clock()) - 1;
        for (const work of works) work.state.backfillFrom ??= latest - (APPSTORES_BACKFILL_DAYS - 1);
        const reports = new Map<number, AppleSalesReport | null>();
        let budget = APPLE_REPORTS_PER_PASS;
        const report = async (day: number, wanting: readonly Work[]): Promise<AppleSalesReport | null> => {
            if (reports.has(day)) return reports.get(day) ?? null;
            if (budget <= 0) return null;
            budget -= 1;
            const got = await this.attempt(pass, wanting, 'les ventes', () =>
                this.clients.apple.fetchSalesReport(creds, day, this.signal, this.clock())
            );
            const value = failed(got) ? null : got.value;
            reports.set(day, value);
            return value;
        };

        // En avant : les jours parus depuis le dernier passage, dans l'ordre.
        const caughtUp = new Set<Work>();
        const forward = works.filter((w) => w.syncedDay !== null);
        for (const work of forward) if ((work.syncedDay ?? latest) >= latest) caughtUp.add(work);
        const start = Math.min(...forward.map((w) => (w.syncedDay ?? latest) + 1), latest + 1);
        for (let day = start; day <= latest && !this.halted(pass); day++) {
            const wanting = forward.filter((w) => !caughtUp.has(w) && w.syncedDay === day - 1);
            if (wanting.length === 0) continue;
            const got = await report(day, wanting);
            if (got === null) break;
            if (got.kind === 'pending') {
                for (const work of wanting) caughtUp.add(work);
                continue;
            }
            for (const work of wanting) {
                await this.applyAppleDay(work, day, got);
                work.syncedDay = day;
                work.historyFrom ??= day;
                if (day >= latest) caughtUp.add(work);
            }
            await this.saveCoverage(wanting);
        }

        // En arrière : le rattrapage, du plus récent au plus ancien jour manquant.
        const fresh = new Set(works.filter((w) => w.syncedDay === null));
        const cursor = new Map<Work, number>();
        for (const work of works) {
            if (work.state.backfillDone) continue;
            cursor.set(work, work.state.backfillAt ?? (work.historyFrom === null ? latest : work.historyFrom - 1));
        }
        while (!this.halted(pass)) {
            for (const [work, day] of cursor) {
                if (day < (work.state.backfillFrom ?? 0)) {
                    work.state.backfillDone = true;
                    delete work.state.backfillAt;
                    cursor.delete(work);
                }
            }
            if (cursor.size === 0) break;
            const day = Math.max(...cursor.values());
            const wanting = [...cursor].filter(([, d]) => d === day).map(([work]) => work);
            const got = await report(day, wanting);
            if (got === null) break;
            for (const work of wanting) {
                if (got.kind === 'expired') {
                    work.state.backfillDone = true;
                    delete work.state.backfillAt;
                    cursor.delete(work);
                } else if (got.kind === 'pending') {
                    // Le haut d'une fiche neuve peut ne pas être paru : on descend sans le compter.
                    if (work.syncedDay === null) cursor.set(work, day - 1);
                    else cursor.delete(work);
                } else {
                    await this.applyAppleDay(work, day, got);
                    // Une relecture repasse sur des jours déjà couverts : la couverture ne recule pas.
                    work.historyFrom = Math.min(work.historyFrom ?? day, day);
                    work.syncedDay ??= day;
                    work.state.backfillAt = day - 1;
                    cursor.set(work, day - 1);
                }
            }
            await this.saveCoverage(wanting);
        }

        for (const work of works) {
            const forwardDone = fresh.has(work) || caughtUp.has(work);
            if (forwardDone && work.state.backfillDone) work.metricsAt = now;
        }
    }

    private async applyAppleDay(work: Work, day: number, report: AppleSalesReport): Promise<void> {
        if (report.kind !== 'rows') return;
        if (work.content.sku === null) {
            const sku = skuOf(report.rows, work.content.externalId);
            if (sku) {
                work.content = { ...work.content, sku };
                work.contentChanged = true;
            }
        }
        const figures = figuresFor(report.rows, { appleId: work.content.externalId, sku: work.content.sku });
        const appId = work.row.app_id;
        if (figures.downloads > 0 || figures.updates > 0) {
            await this.deps.repo.writeDownloads(appId, 'apple', [
                { day, downloads: figures.downloads, updates: figures.updates, uninstalls: null, activeDevices: null }
            ]);
        }
        if (figures.countries.size > 0) {
            await this.deps.repo.writeCountries(
                appId,
                'apple',
                [...figures.countries].map(([country, downloads]) => ({ day, country, downloads }))
            );
        }
        if (figures.revenue.size > 0) {
            await this.deps.repo.replaceRevenue(
                appId,
                'apple',
                day,
                day,
                [...figures.revenue].map(([currency, value]) => ({ day, currency, ...value }))
            );
        }
    }

    /** Les curseurs au fil de l'eau : un arrêt au milieu d'un rattrapage n'en perd rien. */
    private async saveCoverage(works: readonly Work[]): Promise<void> {
        for (const work of works) {
            if (work.syncedDay === work.row.synced_day && work.historyFrom === work.row.history_from) continue;
            await this.deps.repo.saveCoverage(work.row.id, work.syncedDay, work.historyFrom);
            work.row = { ...work.row, synced_day: work.syncedDay, history_from: work.historyFrom };
            work.changed = true;
        }
    }

    /** Les mois à relire : tout le rattrapage, sinon le mois en cours et ceux depuis le dernier jour relevé. */
    private monthsOf(work: Work, today: number): string[] {
        if (!work.state.backfillDone) return monthsDescending(work.state.backfillFrom ?? today, today);
        // Les premiers jours d'un mois, le rapport du précédent s'achève encore.
        return monthsDescending(Math.min(work.syncedDay ?? today, today - 3), today);
    }

    private async googleMetrics(pass: Pass, works: readonly Work[]): Promise<void> {
        if (pass.credentials.store !== 'google') return;
        const { creds } = pass.credentials;
        const unnamed = works.filter((w) => w.content.storeName === null);
        if (unnamed.length > 0 && pass.capabilities.has('apps')) {
            const listed = await this.attempt(pass, unnamed, 'la liste des apps', () =>
                this.clients.google.listApps(creds, this.signal)
            );
            const names = new Map(failed(listed) ? [] : listed.value.map((app) => [app.externalId, app.name]));
            for (const work of unnamed) {
                const name = names.get(work.content.externalId);
                if (name === undefined) continue;
                work.content = { ...work.content, storeName: name };
                work.contentChanged = true;
                work.changed = true;
            }
        }
        const today = utcToday(this.clock());
        for (const work of works) work.state.backfillFrom ??= today - APPSTORES_BACKFILL_DAYS;
        const incomplete = new Set<Work>();
        const budget = { left: GOOGLE_OBJECTS_PER_PASS };

        for (const work of works) {
            if (this.halted(pass)) {
                incomplete.add(work);
                continue;
            }
            const months = this.monthsOf(work, today);
            const reports = [
                ...(pass.capabilities.has('downloads') ? (['installs', 'countries'] as const) : []),
                ...(pass.capabilities.has('ratings') ? (['ratings'] as const) : [])
            ];
            for (const kind of reports) {
                if (!(await this.googleReports(pass, work, kind, months, budget))) incomplete.add(work);
            }
            if (!incomplete.has(work) && !work.state.backfillDone) {
                work.state.backfillDone = true;
                const from = work.state.backfillFrom;
                if (work.syncedDay !== null && from !== undefined) {
                    work.historyFrom = Math.min(work.historyFrom ?? from, from);
                }
            }
            await this.saveCoverage([work]);
            if (pass.capabilities.has('vitals') && !(await this.googleVitals(pass, work))) incomplete.add(work);
        }

        if (pass.capabilities.has('revenue') && !this.halted(pass)) {
            for (const work of await this.googleSales(pass, works, today, budget)) incomplete.add(work);
        }
        const now = this.nowSeconds();
        for (const work of works) if (!incomplete.has(work)) work.metricsAt = now;
    }

    /**
     * Les rapports mensuels d'un paquet, du plus récent au plus ancien ; un
     * objet dont l'`etag` n'a pas bougé est sauté. `false` quand il en reste à lire.
     */
    private async googleReports(
        pass: Pass,
        work: Work,
        kind: GoogleReport,
        months: readonly string[],
        budget: { left: number }
    ): Promise<boolean> {
        if (pass.credentials.store !== 'google') return true;
        const { creds } = pass.credentials;
        const pkg = work.content.externalId;
        const { what, folder, object } = GOOGLE_REPORTS[kind];
        const listed = await this.attempt(pass, work, what, () =>
            this.clients.google.listObjects(creds, `stats/${folder}/${folder}_${pkg}_`, this.signal)
        );
        if (failed(listed)) return listed.failure === 'refused';
        const objects = new Map(listed.value.map((o) => [o.name, o]));
        const nameOf = (month: string) => object(pkg, month);
        const newest = months.find((month) => objects.has(nameOf(month)));
        const etags = (work.state.etags ??= {});
        let oldest: number | null = null;
        for (const month of months) {
            const name = nameOf(month);
            const object = objects.get(name);
            if (object && !(object.etag && etags[name] === object.etag)) {
                if (budget.left <= 0 || this.halted(pass)) return false;
                budget.left -= 1;
                const read = await this.attempt(pass, work, what, () =>
                    this.clients.google.downloadObject(creds, name, OBJECT_MAX_BYTES, this.signal)
                );
                if (failed(read)) return read.failure === 'refused';
                const bytes = read.value;
                // Un rapport qui ne se lit plus est une panne de ce serveur, pas de la clé.
                if (kind === 'installs') {
                    const parsed = await this.attempt(pass, work, what, async () => parseInstalls(bytes));
                    if (failed(parsed)) return false;
                    const days = parsed.value;
                    await this.deps.repo.writeDownloads(work.row.app_id, 'google', days);
                    const last = Math.max(...days.map((d) => d.day));
                    if (days.length > 0 && (work.syncedDay === null || last > work.syncedDay)) work.syncedDay = last;
                } else if (kind === 'countries') {
                    const parsed = await this.attempt(pass, work, what, async () => parseCountryInstalls(bytes));
                    if (failed(parsed)) return false;
                    await this.deps.repo.writeCountries(work.row.app_id, 'google', parsed.value);
                } else {
                    const parsed = await this.attempt(pass, work, what, async () => parseRatings(bytes));
                    if (failed(parsed)) return false;
                    const days = parsed.value;
                    await this.deps.repo.writeRatings(
                        work.row.app_id,
                        'google',
                        days.map((d) => ({ day: d.day, rating: d.rating, count: null }))
                    );
                    const last = days.reduce<{ day: number; rating: number } | null>(
                        (best, d) => (best === null || d.day > best.day ? d : best),
                        null
                    );
                    if (last && month === newest) work.state.rating = last.rating;
                }
                etags[name] = object.etag;
                work.changed = true;
            }
            if (kind === 'installs' && !work.state.backfillDone) {
                const from = Math.max(monthBounds(month).from, work.state.backfillFrom ?? 0);
                oldest = oldest === null ? from : Math.min(oldest, from);
                if (work.syncedDay !== null) work.historyFrom = Math.min(work.historyFrom ?? oldest, oldest);
            }
        }
        return true;
    }

    /** Le rapport de ventes d'un mois sert toutes les apps du compte : lu une fois, réparti par paquet. */
    private async googleSales(
        pass: Pass,
        works: readonly Work[],
        today: number,
        budget: { left: number }
    ): Promise<Work[]> {
        if (pass.credentials.store !== 'google') return [];
        const { creds } = pass.credentials;
        const wanted = new Map(works.map((w) => [w, new Set(this.monthsOf(w, today))]));
        const listed = await this.attempt(pass, [...works], 'les ventes', () =>
            this.clients.google.listObjects(creds, 'sales/salesreport_', this.signal)
        );
        if (failed(listed)) return listed.failure === 'refused' ? [] : [...works];
        const objects = new Map(listed.value.map((o) => [o.name, o]));
        const months = [...new Set([...wanted.values()].flatMap((set) => [...set]))].sort().reverse();
        for (const month of months) {
            const name = salesObject(month);
            const object = objects.get(name);
            if (!object) continue;
            const needing = works.filter(
                (w) => wanted.get(w)?.has(month) && !(object.etag && w.state.etags?.[name] === object.etag)
            );
            if (needing.length === 0) continue;
            if (budget.left <= 0 || this.halted(pass)) return [...works];
            budget.left -= 1;
            const read = await this.attempt(pass, needing, 'les ventes', async () => {
                const zip = await this.clients.google.downloadObject(creds, name, OBJECT_MAX_BYTES, this.signal);
                return parseSales(decodeText((await unzipFirst(zip, SALES_MAX_OUTPUT)).data));
            });
            if (failed(read)) return read.failure === 'refused' ? [] : [...works];
            const { from, to } = monthBounds(month);
            for (const work of needing) {
                const days = read.value.get(work.content.externalId);
                const rows = [...(days ?? new Map())].flatMap(([day, currencies]) =>
                    [...currencies].map(([currency, value]) => ({
                        day,
                        currency,
                        amount: value.amount,
                        units: value.units
                    }))
                );
                await this.deps.repo.replaceRevenue(work.row.app_id, 'google', from, to, rows);
                (work.state.etags ??= {})[name] = object.etag;
                work.changed = true;
            }
        }
        return [];
    }

    /** Les taux perçus des derniers jours, puis leur moyenne sur 28 jours face aux seuils de Google. */
    private async googleVitals(pass: Pass, work: Work): Promise<boolean> {
        if (pass.credentials.store !== 'google') return true;
        const { creds } = pass.credentials;
        const read = await this.attempt(pass, work, 'la stabilité', () =>
            this.clients.google.fetchVitals(creds, work.content.externalId, VITALS_DAYS, this.signal)
        );
        if (failed(read)) return read.failure === 'refused';
        const days = read.value;
        if (days.length === 0) return true;
        await this.deps.repo.writeVitals(work.row.app_id, 'google', days);
        const last = Math.max(...days.map((d) => d.day));
        const window = days.filter((d) => d.day > last - APPSTORES_VITALS_WINDOW_DAYS);
        const vitals = (work.state.vitals ??= {});
        if (vitals.day !== last) work.changed = true;
        vitals.day = last;
        const checks = [
            ['crash', weightedRate(window, 'crashRate'), APPSTORES_CRASH_THRESHOLD],
            ['anr', weightedRate(window, 'anrRate'), APPSTORES_ANR_THRESHOLD]
        ] as const;
        for (const [metric, rate, threshold] of checks) {
            if (rate === null) continue;
            const over = rate > threshold;
            // La première mesure fixe l'état sans prévenir : rien n'a franchi le seuil sous nos yeux.
            if (vitals[metric] !== undefined && vitals[metric] !== over) {
                work.vitalsNotices.push({ metric, over, rate });
                work.changed = true;
            }
            vitals[metric] = over;
        }
        return true;
    }

    // ------------------------------------------------------------- avis, versions, note

    private async listingSteps(pass: Pass, cipher: SdkCipher, work: Work): Promise<void> {
        const now = this.nowSeconds();
        if (this.due(work, work.row.reviews_synced_at, REVIEWS_EVERY)) {
            work.touched = true;
            if (!pass.capabilities.has('reviews')) work.reviewsAt = now;
            else if (await this.reviews(pass, cipher, work)) work.reviewsAt = now;
            if (pass.capabilities.has('versions')) await this.versions(pass, work);
        }
        if (pass.credentials.store === 'apple' && this.due(work, work.row.rating_synced_at, RATING_EVERY)) {
            work.touched = true;
            if (await this.rating(pass, work)) work.ratingAt = now;
        }
    }

    /** `true` quand la lecture des avis est complète pour cette cadence. */
    private async reviews(pass: Pass, cipher: SdkCipher, work: Work): Promise<boolean> {
        const now = this.nowSeconds();
        const horizon = now - APPSTORES_REVIEWS_KEEP_DAYS * DAY_SECONDS;
        const seeded = work.state.reviewsSeeded === true;

        if (pass.credentials.store === 'google') {
            const { creds } = pass.credentials;
            const read = await this.attempt(pass, work, 'les avis', () =>
                this.clients.google.fetchReviews(creds, work.content.externalId, this.signal)
            );
            if (failed(read)) return read.failure === 'refused';
            await this.storeReviews(cipher, work, read.value, horizon, seeded);
            work.state.reviewsSeeded = true;
            return true;
        }

        const { creds } = pass.credentials;
        // Le premier passage remonte jusqu'à l'horizon, sur plusieurs passes s'il le faut ;
        // les suivants s'arrêtent au premier avis déjà connu.
        let target: string | null = seeded
            ? firstReviewsPage(work.content.externalId)
            : (work.state.reviewsCursor ?? firstReviewsPage(work.content.externalId));
        const seen = new Set<string>();
        for (let page = 0; target !== null; page++) {
            if (page >= REVIEW_PAGES_PER_PASS || this.halted(pass)) {
                if (!seeded) {
                    work.state.reviewsCursor = target;
                    await this.persist(cipher, work);
                }
                return seeded;
            }
            const url: string = target;
            const read = await this.attempt(pass, work, 'les avis', () =>
                this.clients.apple.fetchReviewsPage(creds, url, this.signal)
            );
            if (failed(read)) return read.failure === 'refused';
            for (const review of read.value.reviews) seen.add(review.externalId);
            const { known, oldest } = await this.storeReviews(cipher, work, read.value.reviews, horizon, seeded);
            const reachedEnd = read.value.next === null || (oldest !== null && oldest < horizon);
            target = reachedEnd || (seeded && known > 0) ? null : read.value.next;
            if (!seeded) {
                work.state.reviewsCursor = target;
                await this.persist(cipher, work);
            }
        }
        work.state.reviewsSeeded = true;
        work.state.reviewsCursor = null;
        await this.pendingReplies(pass, cipher, work, seen);
        return true;
    }

    /**
     * Range une page d'avis : les neufs s'insèrent, les connus se mettent à jour
     * s'ils ont changé (une réponse publiée, un avis corrigé). Les neufs d'une
     * fiche déjà amorcée partent dans l'avis du passage.
     */
    private async storeReviews(
        cipher: SdkCipher,
        work: Work,
        reviews: readonly StoreReview[],
        horizon: number,
        announce: boolean
    ): Promise<{ known: number; oldest: number | null }> {
        const store = work.row.store;
        const kept = reviews.filter((r) => r.createdAt >= horizon);
        const refs = kept.map((r) => reviewRef(store, r.externalId));
        const existing = new Map(
            (await this.deps.repo.reviewsByRefs(work.row.app_id, store, refs)).map((row) => [row.external_ref, row])
        );
        let known = 0;
        for (const review of kept) {
            const ref = reviewRef(store, review.externalId);
            const stored = storedReviewOf(review);
            const row = existing.get(ref);
            if (row) {
                known += 1;
                const current = await readJson<StoredReview>(cipher, row.content);
                if (current && sameReview(current, stored) && Number(row.rating) === review.rating) continue;
                await this.deps.repo.updateReview(row.id, {
                    rating: review.rating,
                    repliedAt: review.reply ? (review.reply.at ?? row.replied_at ?? this.nowSeconds()) : null,
                    content: await sealJson(cipher, stored)
                });
                work.changed = true;
                continue;
            }
            const inserted = await this.deps.repo.insertReview({
                appId: work.row.app_id,
                store,
                externalRef: ref,
                rating: review.rating,
                createdAt: review.createdAt,
                repliedAt: review.reply ? (review.reply.at ?? review.createdAt) : null,
                content: await sealJson(cipher, stored)
            });
            if (!inserted) continue;
            work.changed = true;
            if (announce) work.newReviews.push(review);
        }
        const oldest = reviews.length > 0 ? Math.min(...reviews.map((r) => r.createdAt)) : null;
        return { known, oldest };
    }

    /** Une réponse Apple attend sa relecture : on relit celles des deux dernières semaines que la page n'a pas rendues. */
    private async pendingReplies(pass: Pass, cipher: SdkCipher, work: Work, seen: ReadonlySet<string>): Promise<void> {
        if (pass.credentials.store !== 'apple') return;
        const { creds } = pass.credentials;
        const rows = await this.deps.repo.repliedSince(
            work.row.app_id,
            'apple',
            this.nowSeconds() - PENDING_REPLY_SECONDS
        );
        for (const row of rows) {
            if (this.halted(pass)) return;
            const stored = await readJson<StoredReview>(cipher, row.content);
            if (!stored?.reply?.responseId || stored.reply.state !== 'pending' || seen.has(stored.externalId)) continue;
            const responseId = stored.reply.responseId;
            const read = await this.attempt(pass, work, 'les réponses', () =>
                this.clients.apple.fetchResponse(creds, responseId, this.signal)
            );
            if (failed(read)) return;
            const reply = read.value;
            if (reply && reply.state === stored.reply.state && reply.body === stored.reply.body) continue;
            await this.deps.repo.updateReview(row.id, {
                rating: Number(row.rating),
                repliedAt: reply ? (reply.at ?? row.replied_at) : null,
                content: await sealJson(cipher, { ...stored, reply })
            });
            work.changed = true;
        }
    }

    /**
     * Les versions d'un store, et l'avis de chaque étape utile d'Apple ; la
     * première lecture ne fait que noter. Google ne donne pas d'identifiant à
     * part : le nom de la version en tient lieu.
     */
    private async versions(pass: Pass, work: Work): Promise<void> {
        const credentials = pass.credentials;
        const read = await this.attempt(pass, work, 'les versions', async () =>
            credentials.store === 'apple'
                ? this.clients.apple.fetchVersions(credentials.creds, work.content.externalId, this.signal)
                : (
                      await this.clients.google.fetchReleases(credentials.creds, work.content.externalId, this.signal)
                  ).map((release) => ({ id: release.version, version: release.version, state: release.state }))
        );
        if (failed(read)) return;
        const now = this.nowSeconds();
        const first = work.state.phases === undefined;
        const phases = work.state.phases ?? {};
        const previous = work.state.versions ?? [];
        const nextPhases: Record<string, string> = {};
        for (const version of read.value) {
            const phase = phaseOf(version.state);
            nextPhases[version.id] = phase ?? '';
            if (!first && phase !== null && phases[version.id] !== phase) {
                work.versionNotices.push({ version: version.version, phase });
            }
        }
        const current: AppStoresVersion[] = read.value.slice(0, VERSIONS_KEPT).map((v) => {
            const same = previous.find((p) => p.version === v.version && p.state === v.state);
            return { version: v.version, state: v.state, since: same ? same.since : first ? null : now };
        });
        // Google ne rend que ses versions actives : les précédentes restent de mémoire, depuis le branchement.
        const remembered =
            credentials.store === 'google' ? previous.filter((p) => !current.some((v) => v.version === p.version)) : [];
        const versions = [...current, ...remembered].slice(0, VERSIONS_KEPT);
        if (JSON.stringify(versions) !== JSON.stringify(previous)) work.changed = true;
        work.state.versions = versions;
        work.state.phases = nextPhases;
    }

    /** La note Apple du pays de référence, rangée au dernier jour relevé de la fiche. */
    private async rating(pass: Pass, work: Work): Promise<boolean> {
        const read = await this.attempt(
            pass,
            work,
            'la note',
            () => this.clients.apple.fetchRating(work.content.externalId, work.ratingCountry, this.signal),
            true
        );
        // Une note qui ne se lit pas attend demain : elle bouge peu, et l'API publique n'a pas de repli.
        if (failed(read) || read.value === null) return true;
        const day = work.syncedDay ?? utcToday(this.clock()) - 1;
        await this.deps.repo.writeRatings(work.row.app_id, 'apple', [
            { day, rating: read.value.rating, count: read.value.count }
        ]);
        if (work.state.rating !== read.value.rating || work.state.ratingCount !== read.value.count) {
            work.state.rating = read.value.rating;
            work.state.ratingCount = read.value.count;
            work.changed = true;
        }
        return true;
    }

    // ------------------------------------------------------------- la fin d'une passe

    /** L'état d'abord, les avis ensuite : un avis parti sur un état non écrit repartirait. */
    private async finish(pass: Pass, cipher: SdkCipher, works: readonly Work[]): Promise<void> {
        for (const work of works) if (work.touched) await this.persist(cipher, work);
        await this.settleSource(pass, cipher);
        await this.announce(pass, works);
        if (pass.changed || works.some((w) => w.changed)) this.deps.live.changed(pass.source.workspace_id);
    }

    private async settleSource(pass: Pass, cipher: SdkCipher): Promise<void> {
        const { source } = pass;
        if (pass.interrupted) return;
        const now = this.nowSeconds();
        const notify = this.deps.deveyeFor(source.workspace_id).notify;
        const announce = (state: { lost: boolean; cause: string; at: number }) =>
            announceSource(this.deps.repo, cipher, notify, source, state).catch((e: unknown) => {
                this.deps.logger.warn({ err: e, sourceId: source.id }, 'Stores : avis de la source non envoyé');
                return false;
            });
        if (pass.ok > 0 && !pass.keyRefused) {
            if (Number(source.failing_count) > 0 || source.failing_since !== null) {
                await this.deps.repo.clearSourceFailure(source.id);
                pass.changed = true;
                if (Number(source.failing_notified) === 1) await announce({ lost: false, cause: '', at: now });
            }
        } else if (pass.refused) {
            const cause = failureSentence(pass.refused, pass.label, 'les données de ses apps').slice(0, SENTENCE_MAX);
            const before = Number(source.failing_count);
            const after = await this.deps.repo.recordRefusal(source.id, { at: now, error: cause });
            if (after && after.count >= LOST_AFTER_REFUSALS) pass.changed = true;
            // L'avis part au franchissement, une fois ; `failing_notified` dit qu'un canal l'a reçu.
            if (after && before < LOST_AFTER_REFUSALS && after.count >= LOST_AFTER_REFUSALS && !after.notified) {
                if (await announce({ lost: true, cause, at: now })) await this.deps.repo.markSourceNotified(source.id);
            }
        }

        const failure = pass.rateLimited ?? pass.failed ?? (pass.ok === 0 || pass.keyRefused ? pass.refused : null);
        if (failure !== null && failure !== undefined) {
            this.bumpBackoff(source.id, pass.rateLimited?.retryAt ?? null);
            const status = failure instanceof StoreError ? failure.status : null;
            const userSide =
                (status !== null && status >= 400 && status < 500 && status !== 400 && status !== 422) ||
                isRemoteFailure(failure instanceof StoreError ? (failure.cause ?? failure) : failure);
            logFailure(
                this.deps.logger,
                userSide,
                {
                    sourceId: source.id,
                    store: source.store,
                    status,
                    detail: failure instanceof StoreError ? failure.detail : null,
                    err: failure instanceof Error ? failure.message : String(failure)
                },
                'Stores : passe incomplète'
            );
        } else if (pass.ok > 0) {
            this.backoff.delete(source.id);
        }
    }

    private async announce(pass: Pass, works: readonly Work[]): Promise<void> {
        const notify = this.deps.deveyeFor(pass.source.workspace_id).notify;
        const at = this.nowSeconds();
        for (const work of works) {
            const itemId = work.row.app_id;
            const sends = [
                ...(work.newReviews.length > 0
                    ? [reviewsNotice({ app: work.appName, store: work.row.store, reviews: work.newReviews, at })]
                    : []),
                ...work.versionNotices.map((v) => versionNotice({ app: work.appName, ...v, at })),
                ...work.vitalsNotices.map((v) => vitalsNotice({ app: work.appName, ...v, at }))
            ];
            for (const alert of sends) {
                await notify
                    .send(alert, { itemId })
                    .catch((e: unknown) =>
                        this.deps.logger.warn({ err: e, appId: itemId }, 'Stores : avis non envoyé')
                    );
            }
        }
    }
}
