import type { Logger } from 'pino';

import {
    AUDIENCE_SESSION_GAP_SECONDS,
    type AudienceEventInput,
    type AudiencePlatform,
    type AudienceSiteRow,
    type AudienceVisitorMode
} from 'deveye-types';

import type { Database as Db } from '@/db';
import type { PendingEventRow } from '@/db/repos/audienceIngest';
import type { LiveHub } from '@/live/hub';
import type Encryption from '@/Services/Encryption';
import { createOpenCipher, type Cipher } from '@/Services/SecureStore';
import { env } from '@/Utils/Env';

import {
    dayBounds,
    dayKey,
    labelRef,
    normalizePath,
    normalizeReferrer,
    originAllowed,
    persistentVisitorRef,
    visitorRef
} from './audience/normalize';
import { looksLikeBot, parseUserAgent } from './audience/userAgent';

/**
 * L'ingestion de l'audience : le seul chemin de DevEye ouvert sur Internet.
 *
 * ## Ce qui coûte, et ce qui n'est donc pas fait dans la requête
 *
 * Une requête d'ingestion arrive à la cadence des visites de tous les sites de
 * tous les espaces. Elle ne fait donc, dans le cas courant, **aucune requête
 * SQL** : le site est résolu depuis un cache mémoire, le visiteur est condensé,
 * et l'événement part dans une file. Tout le travail de base a lieu dans la
 * vidange, une fois par seconde, en lots.
 *
 * Le prix, à dire franchement : **une seconde d'événements est perdue** si le
 * processus tombe entre deux vidanges. C'est de l'analytique, pas de la
 * comptabilité — et la garantie inverse aurait coûté un aller-retour SQL
 * synchrone à chaque page vue de chaque site.
 *
 * ## Le direct, coalescé
 *
 * Diffuser un `live.changed` par événement ferait re-solliciter l'écran de tous
 * les membres de l'espace à chaque visite. La diffusion est donc regroupée à
 * **une par minute et par espace** — la cadence demandée, et bien assez pour
 * une donnée qui se lit en tendance.
 *
 * Deux garde-fous sont déjà là et n'ont pas à être refaits : `LiveHub.changed`
 * ne fait rien quand personne n'est dans la salle, et son plancher de 200 ms
 * (qui doit rester sous l'anti-rebond client de 250 ms) protège le reste du
 * système. La coalescence à la minute vit **ici**, jamais dans le hub.
 */

export interface AudienceIngestDeps {
    db: Db;
    crypt: Encryption;
    logger: Logger;
    live: LiveHub;
}

/** Une requête d'ingestion, une fois l'enveloppe HTTP ôtée. */
export interface IngestRequest {
    key: string;
    /**
     * L'identifiant que le client garde d'une visite à l'autre, s'il en pose un.
     * **Ignoré** quand le site n'est pas en mode persistant : les deux côtés
     * doivent être d'accord, et c'est le réglage du site qui tranche.
     */
    visitorId?: string | null;
    /** En-tête `Origin`, ou `null` : un client natif n'en envoie pas. */
    origin: string | null;
    ip: string;
    userAgent: string;
    events: AudienceEventInput[];
}

/** Le site tel que le cache le tient — que ce dont l'ingestion a besoin. */
interface CachedSite {
    id: number;
    workspaceId: number;
    publicKey: string;
    platform: AudiencePlatform;
    visitorMode: AudienceVisitorMode;
    origins: string[];
    active: boolean;
}

/** Un événement accepté, en attente d'écriture. */
interface QueuedEvent {
    siteId: number;
    workspaceId: number;
    visitorRef: string;
    ts: number;
    kind: 0 | 1;
    path: string;
    name: string | null;
    referrer: string | null;
    browser: string;
    os: string;
    device: string;
    timezone: string | null;
    language: string | null;
    identity: string | null;
    tzOffset: number | null;
    screenWidth: number | null;
}

/** Une session ouverte, telle que le cache la tient entre deux vidanges. */
interface CachedSession {
    id: number;
    lastAt: number;
    identityId: number | null;
}

/** Cadence de vidange de la file. */
const FLUSH_MS = 1000;

/** Cadence du ménage : agrégat journalier, rétention, libellés orphelins. */
const MAINTENANCE_MS = 60 * 60 * 1000;

/**
 * Une diffusion `live` par espace au plus, sur cette période.
 *
 * ⚠️ **N'a rien à voir avec `TOPIC_FLOOR_MS` du hub** (200 ms), qui doit rester
 * sous l'anti-rebond du client. Celui-ci est un choix de produit — une audience
 * se lit en tendance, la rafraîchir plus souvent ne montrerait rien de plus et
 * ferait re-solliciter tous les écrans de l'espace.
 */
const BROADCAST_FLOOR_MS = 60_000;

/**
 * Plafond de la file. Au-delà, on jette et on le dit.
 *
 * Sans lui, une base indisponible transformerait la mémoire du processus en
 * file d'attente sans fond — et le serveur tomberait pour une feature qui n'est
 * pas critique. Jeter des visites est le bon compromis ; s'arrêter ne l'est pas.
 */
const QUEUE_MAX = 20_000;

/** Bornes des caches. Un dépassement vide, sans finesse : on recalcule. */
const LABEL_CACHE_MAX = 20_000;
const SESSION_CACHE_MAX = 20_000;
const UNKNOWN_KEY_CACHE_MAX = 1_000;

export class AudienceIngest {
    private flushTimer: ReturnType<typeof setInterval> | null = null;
    private maintenanceTimer: ReturnType<typeof setInterval> | null = null;
    private flushing = false;

    /** `public_key` → site. Vidé à toute mutation d'un site (voir `invalidate`). */
    private readonly sites = new Map<string, CachedSite>();
    /**
     * Les clés qu'aucun site ne porte.
     *
     * Sans cette mémoire, un client mal configuré — ou hostile — ferait une
     * requête SQL par événement pour toujours. Bornée, parce qu'elle est
     * alimentée par une entrée publique : c'est une file d'oubli, pas un cache.
     */
    private readonly unknownKeys = new Set<string>();

    /** `siteId:kind:ref` → id du libellé. */
    private readonly labels = new Map<string, number>();
    /** `siteId:visitorRef` → session ouverte. */
    private readonly sessions = new Map<string, CachedSession>();
    private readonly ciphers = new Map<number, Cipher>();

    private queue: QueuedEvent[] = [];
    private dropped = 0;
    private readonly lastBroadcast = new Map<number, number>();

    constructor(private readonly deps: AudienceIngestDeps) {}

    start(): void {
        if (this.flushTimer) return;
        this.flushTimer = setInterval(() => void this.flush(), FLUSH_MS);
        this.flushTimer.unref();
        this.maintenanceTimer = setInterval(() => void this.maintain(), MAINTENANCE_MS);
        this.maintenanceTimer.unref();
        // Un premier ménage au démarrage : c'est le seul moment où l'on est sûr
        // de passer, même sur une instance qui ne tourne qu'une heure par jour.
        setTimeout(() => void this.maintain(), 30_000).unref();
        this.deps.logger.info({ flushMs: FLUSH_MS }, 'Audience ingest started');
    }

    stop(): void {
        if (this.flushTimer) clearInterval(this.flushTimer);
        if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
        this.flushTimer = null;
        this.maintenanceTimer = null;
        // Une dernière vidange : un arrêt propre n'a pas de raison de perdre ce
        // qui est déjà accepté.
        void this.flush();
    }

    /**
     * Oublie tout ce qu'on savait des sites.
     *
     * Appelé après **toute** mutation d'un site — création, réglages, rotation
     * de clé, suppression. Vider en entier plutôt que cibler : la carte compte
     * quelques dizaines d'entrées, et une invalidation partielle est exactement
     * le genre de finesse qui laisse une entrée périmée derrière elle.
     */
    invalidate(): void {
        this.sites.clear();
        this.unknownKeys.clear();
    }

    /**
     * Accepte (ou ignore en silence) une requête d'ingestion.
     *
     * **Ne lève jamais et ne dit jamais non.** L'appelant répond `204` quoi
     * qu'il arrive : distinguer les refus ferait de cet endpoint un oracle, qui
     * dirait à n'importe qui quelles clés existent.
     */
    async accept(req: IngestRequest): Promise<void> {
        const site = await this.resolveSite(req.key);
        if (!site || !site.active) return;
        if (!originAllowed(site.origins, req.origin, site.platform)) return;
        if (looksLikeBot(req.userAgent)) return;

        const ua = parseUserAgent(req.userAgent);

        // Deux façons de reconnaître quelqu'un, et le réglage du site tranche.
        //
        // En persistant, on se fie à l'identifiant que le client garde : c'est
        // ce qui rend la même personne reconnaissable d'un jour à l'autre, donc
        // les visiteurs connus mesurables. Un client qui n'en envoie pas malgré
        // le réglage retombe sur l'anonyme — il compte, simplement il ne sera
        // jamais « déjà venu ».
        const persistent = site.visitorMode === 'persistent' && !!req.visitorId;
        const visitor = persistent
            ? persistentVisitorRef(env.CRYPT_KEY_A, site.publicKey, req.visitorId as string)
            : visitorRef(this.dailySalt(), site.publicKey, req.ip, req.userAgent);
        const now = Math.floor(Date.now() / 1000);

        for (const event of req.events) {
            if (this.queue.length >= QUEUE_MAX) {
                this.dropped++;
                return;
            }
            const name = event.type === 'event' ? event.name?.trim() || null : null;
            // Un événement nommé sans nom n'est rien : le laisser entrer
            // produirait une ligne que rien ne pourrait jamais désigner.
            if (event.type === 'event' && !name) continue;

            this.queue.push({
                siteId: site.id,
                workspaceId: site.workspaceId,
                visitorRef: visitor,
                ts: this.clampTimestamp(event.at, now),
                kind: event.type === 'event' ? 1 : 0,
                path: normalizePath(event.path),
                name,
                referrer: normalizeReferrer(event.referrer, site.origins),
                // Ce que le client déclare l'emporte sur ce qu'on devine : un
                // client natif *sait*, là où le user-agent est une supposition.
                browser: event.browser?.trim() || ua.browser,
                os: event.os?.trim() || ua.os,
                device: event.device?.trim() || ua.device,
                timezone: event.timezone?.trim() || null,
                language: event.language?.trim().slice(0, 35) || null,
                identity: event.identity?.trim() || null,
                tzOffset: event.tzOffset ?? null,
                screenWidth: event.screenWidth ?? null
            });
        }
    }

    /**
     * Le sel du jour : dérivé d'un secret du serveur et de la date UTC.
     *
     * Dérivé, et non tiré au sort au démarrage : un redémarrage compterait
     * sinon deux fois chaque visiteur de la journée. Tournant, et non fixe :
     * c'est ce qui garantit qu'aucun identifiant ne suit quelqu'un d'un jour à
     * l'autre.
     */
    private dailySalt(): string {
        return `${env.CRYPT_KEY_A}:${dayKey(Math.floor(Date.now() / 1000))}`;
    }

    /**
     * L'horodatage retenu.
     *
     * Un client peut en proposer un — c'est ce qui permettra à un module natif
     * de livrer ce qu'il a mis de côté hors ligne. Il est **borné** aux
     * dernières 24 heures : une horloge fausse ne doit pas pouvoir dater une
     * visite de 2038 et écraser l'échelle de tous les graphes de l'espace.
     */
    private clampTimestamp(proposed: number | undefined, now: number): number {
        if (proposed === undefined) return now;
        if (proposed > now) return now;
        return Math.max(proposed, now - 86400);
    }

    private async resolveSite(key: string): Promise<CachedSite | null> {
        const cached = this.sites.get(key);
        if (cached) return cached;
        if (this.unknownKeys.has(key)) return null;

        let row: AudienceSiteRow | null = null;
        try {
            row = await this.deps.db.audienceIngest.findByPublicKey(key);
        } catch (e) {
            this.deps.logger.error({ err: e }, 'Audience ingest: site lookup failed');
            return null;
        }
        if (!row) {
            if (this.unknownKeys.size >= UNKNOWN_KEY_CACHE_MAX) this.unknownKeys.clear();
            this.unknownKeys.add(key);
            return null;
        }

        const site: CachedSite = {
            id: Number(row.id),
            workspaceId: Number(row.workspace_id),
            publicKey: row.public_key,
            platform: (row.platform as AudiencePlatform) ?? 'web',
            visitorMode: row.visitor_mode === 'persistent' ? 'persistent' : 'anonymous',
            origins: parseOrigins(row.origins),
            active: Number(row.active) === 1
        };
        this.sites.set(key, site);
        return site;
    }

    private cipherFor(workspaceId: number): Cipher {
        let cipher = this.ciphers.get(workspaceId);
        if (!cipher) {
            cipher = createOpenCipher(this.deps.db, this.deps.crypt, workspaceId);
            this.ciphers.set(workspaceId, cipher);
        }
        return cipher;
    }

    /**
     * L'identifiant d'un libellé, du cache ou de la base.
     *
     * Le cache est ce qui rend la feature tenable : un site qui a trente pages
     * résout trente libellés une fois, puis plus jamais. Sans lui, chaque
     * visite ferait un aller-retour SQL **et** un chiffrement par dimension.
     */
    private async resolveLabel(siteId: number, kind: string, value: string, cipher: Cipher): Promise<number> {
        const ref = labelRef(value);
        const cacheKey = `${siteId}:${kind}:${ref}`;
        const hit = this.labels.get(cacheKey);
        if (hit !== undefined) return hit;

        const content = await cipher.encrypt(value);
        const id = await this.deps.db.audienceIngest.resolveLabel(siteId, kind, ref, content);
        if (this.labels.size >= LABEL_CACHE_MAX) this.labels.clear();
        this.labels.set(cacheKey, id);
        return id;
    }

    /** `undefined` en entrée = pas de dimension, donc pas de libellé. */
    private async resolveOptional(
        siteId: number,
        kind: string,
        value: string | null,
        cipher: Cipher
    ): Promise<number | null> {
        if (!value) return null;
        return this.resolveLabel(siteId, kind, value, cipher);
    }

    private async flush(): Promise<void> {
        if (this.flushing || this.queue.length === 0) return;
        this.flushing = true;
        const batch = this.queue;
        this.queue = [];

        if (this.dropped > 0) {
            this.deps.logger.warn({ dropped: this.dropped }, 'Audience ingest: queue full, events dropped');
            this.dropped = 0;
        }

        try {
            const events: PendingEventRow[] = [];
            /** `sessionId` → vues à ajouter et instant le plus récent. */
            const touched = new Map<number, { views: number; lastAt: number }>();
            const siteLastAt = new Map<number, number>();
            const workspaces = new Set<number>();

            for (const item of batch) {
                const cipher = this.cipherFor(item.workspaceId);
                const session = await this.resolveSession(item, cipher);

                const pathId = await this.resolveLabel(item.siteId, 'path', item.path, cipher);
                const nameId = await this.resolveOptional(item.siteId, 'event', item.name, cipher);

                events.push({
                    siteId: item.siteId,
                    sessionId: session.id,
                    ts: item.ts,
                    kind: item.kind,
                    pathId,
                    nameId
                });

                // Une identité qui apparaît en cours de route rattache la
                // session déjà ouverte : on arrive anonyme, on se connecte, et
                // sans ceci toute visite resterait anonyme jusqu'à la suivante.
                if (item.identity && session.identityId === null) {
                    const identityId = await this.resolveLabel(item.siteId, 'identity', item.identity, cipher);
                    await this.deps.db.audienceIngest.setSessionIdentity(session.id, identityId);
                    session.identityId = identityId;
                }

                const prev = touched.get(session.id) ?? { views: 0, lastAt: 0 };
                touched.set(session.id, {
                    views: prev.views + (item.kind === 0 ? 1 : 0),
                    lastAt: Math.max(prev.lastAt, item.ts)
                });
                session.lastAt = Math.max(session.lastAt, item.ts);
                siteLastAt.set(item.siteId, Math.max(siteLastAt.get(item.siteId) ?? 0, item.ts));
                workspaces.add(item.workspaceId);
            }

            await this.deps.db.audienceIngest.insertEvents(events);
            for (const [sessionId, delta] of touched) {
                await this.deps.db.audienceIngest.touchSession(sessionId, delta.lastAt, delta.views);
            }
            for (const [siteId, at] of siteLastAt) {
                await this.deps.db.audienceIngest.touchSite(siteId, at);
            }
            for (const workspaceId of workspaces) this.maybeBroadcast(workspaceId);
        } catch (e) {
            // La file a déjà été vidée : ce lot est perdu, et c'est voulu. Le
            // remettre en tête ferait boucler indéfiniment sur une écriture qui
            // échoue, en accumulant tout ce qui arrive derrière.
            this.deps.logger.error({ err: e, events: batch.length }, 'Audience ingest: flush failed');
        } finally {
            this.flushing = false;
        }
    }

    /** La session ouverte de ce visiteur, ou une nouvelle. */
    private async resolveSession(item: QueuedEvent, cipher: Cipher): Promise<CachedSession> {
        const cacheKey = `${item.siteId}:${item.visitorRef}`;
        const cached = this.sessions.get(cacheKey);
        if (cached && item.ts - cached.lastAt < AUDIENCE_SESSION_GAP_SECONDS) return cached;

        const since = item.ts - AUDIENCE_SESSION_GAP_SECONDS;
        const open = await this.deps.db.audienceIngest.findOpenSession(item.siteId, item.visitorRef, since);
        if (open) {
            const session: CachedSession = { id: open.id, lastAt: item.ts, identityId: open.identity_id };
            this.remember(cacheKey, session);
            return session;
        }

        // Les dimensions d'une session sont posées **à son ouverture** et n'en
        // bougent plus : elles décrivent une visite, pas un instant. L'identité
        // fait exception, parce qu'elle arrive après coup par construction.
        const id = await this.deps.db.audienceIngest.createSession({
            siteId: item.siteId,
            visitorRef: item.visitorRef,
            at: item.ts,
            entryPathId: await this.resolveLabel(item.siteId, 'path', item.path, cipher),
            referrerId: await this.resolveOptional(item.siteId, 'referrer', item.referrer, cipher),
            browserId: await this.resolveLabel(item.siteId, 'browser', item.browser, cipher),
            osId: await this.resolveLabel(item.siteId, 'os', item.os, cipher),
            deviceId: await this.resolveLabel(item.siteId, 'device', item.device, cipher),
            timezoneId: await this.resolveOptional(item.siteId, 'timezone', item.timezone, cipher),
            languageId: await this.resolveOptional(item.siteId, 'language', item.language, cipher),
            identityId: await this.resolveOptional(item.siteId, 'identity', item.identity, cipher),
            tzOffset: item.tzOffset,
            screenWidth: item.screenWidth
        });
        const session: CachedSession = { id, lastAt: item.ts, identityId: null };
        this.remember(cacheKey, session);
        return session;
    }

    private remember(key: string, session: CachedSession): void {
        if (this.sessions.size >= SESSION_CACHE_MAX) this.sessions.clear();
        this.sessions.set(key, session);
    }

    private maybeBroadcast(workspaceId: number): void {
        const now = Date.now();
        if (now - (this.lastBroadcast.get(workspaceId) ?? 0) < BROADCAST_FLOOR_MS) return;
        this.lastBroadcast.set(workspaceId, now);
        this.deps.live.changed(workspaceId, ['audience'], null);
    }

    /**
     * Le ménage horaire : agrégat, rétention, libellés orphelins.
     *
     * L'agrégat est refait pour **hier et aujourd'hui**. Aujourd'hui parce que
     * la journée bouge encore ; hier parce que rien ne garantit qu'une instance
     * tournait à minuit — et un jour manquant dans l'agrégat est un trou
     * définitif dès que les événements bruts ont expiré.
     */
    private async maintain(): Promise<void> {
        try {
            const now = Math.floor(Date.now() / 1000);
            const sites = await this.deps.db.audienceIngest.listForMaintenance();

            for (const site of sites) {
                for (const at of [now - 86400, now]) {
                    const { from, to } = dayBounds(at);
                    await this.deps.db.audienceIngest.rollupDay(site.id, dayKey(at), from, to);
                }

                const before = now - site.retention_days * 86400;
                const events = await this.deps.db.audienceIngest.pruneEvents(site.id, before);
                const sessions = await this.deps.db.audienceIngest.pruneSessions(site.id, before);
                if (events + sessions > 0) {
                    // Les libellés ne sont balayés que si quelque chose a
                    // réellement disparu : la requête parcourt deux tables de
                    // faits, il n'y a aucune raison de la jouer à vide.
                    const labels = await this.deps.db.audienceIngest.pruneOrphanLabels(site.id);
                    this.deps.logger.info({ siteId: site.id, events, sessions, labels }, 'Audience retention sweep');
                    // Des identifiants viennent de disparaître : le cache les
                    // rendrait encore, et l'insertion suivante buterait sur une
                    // clé étrangère morte.
                    this.labels.clear();
                    this.sessions.clear();
                }
            }
        } catch (e) {
            this.deps.logger.error({ err: e }, 'Audience ingest: maintenance failed');
        }
    }
}

/** Les origines telles que la colonne les porte : une par ligne, normalisées. */
export function parseOrigins(raw: string | null): string[] {
    if (!raw) return [];
    return raw
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
}
