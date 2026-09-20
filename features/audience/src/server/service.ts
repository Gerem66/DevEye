import {
    AUDIENCE_FORM_SUBMISSIONS_MAX,
    AUDIENCE_MAX_FORMS,
    AUDIENCE_SESSION_GAP_SECONDS,
    type AudienceEventInput,
    type AudienceFieldValue,
    type AudienceFormField,
    type AudienceFormMode,
    type AudiencePlatform,
    type AudienceSiteRow,
    type AudienceVisitorMode
} from '../contracts/domain';
import type { FeatureService, FeatureServiceDeps, SdkCipher } from '@deveye/types/sdk/server';

import {
    dayBounds,
    dayKey,
    labelRef,
    normalizePath,
    normalizeReferrer,
    originAllowed,
    persistentVisitorRef,
    visitorRef
} from './normalize';
import { countAnswers } from './answers';
import type { AudienceRepo, PendingEventRow } from './repo';
import { validateSubmission, type ValidationReason } from './validate';
import { nameRef, parseOrigins, readJson } from './_shared';
import { looksLikeBot, parseUserAgent } from './userAgent';
import { FeatureError } from '@deveye/types/sdk/server';

/**
 * L'ingestion de l'audience : le seul chemin de DevEye ouvert sur Internet.
 *
 * Une requête d'ingestion arrive à la cadence des visites de tous les sites de
 * tous les espaces. Elle ne fait donc, dans le cas courant, aucune requête SQL :
 * le site vient d'un cache mémoire, le visiteur est condensé, l'événement part
 * dans une file, et tout le travail de base a lieu à la vidange, en lots. Le
 * prix : une seconde d'événements est perdue si le processus tombe entre deux
 * vidanges.
 *
 * Le direct est coalescé à une diffusion par minute et par espace ; en émettre
 * une par événement ferait re-solliciter l'écran de tous les membres à chaque
 * visite. Cette coalescence vit ici, jamais dans le hub.
 *
 * Les **retours** entrent par la même porte et le même service, mais pas par la
 * file : `submit()` écrit avant de rendre la main. Une vue perdue au
 * redémarrage n'est rien, un message que personne ne lira l'est.
 */

/** Une requête d'ingestion, une fois l'enveloppe HTTP ôtée. */
export interface IngestRequest {
    key: string;
    /**
     * L'identifiant que le client garde d'une visite à l'autre, s'il en pose un.
     * Ignoré quand le site n'est pas en mode persistant : c'est le réglage du
     * site qui tranche.
     */
    visitorId?: string | null;
    /** En-tête `Origin`, ou `null` : un client natif n'en envoie pas. */
    origin: string | null;
    ip: string;
    userAgent: string;
    events: AudienceEventInput[];
}

/**
 * Un retour, une fois l'enveloppe HTTP ôtée. Les deux formes d'envoi (JSON et
 * formulaire HTML) se ramènent à celle-ci avant d'arriver ici : le service ne
 * sait pas par quelle porte on est entré.
 */
export interface SubmitRequest {
    key: string;
    form: string;
    fields: Record<string, AudienceFieldValue>;
    /** La page d'où part le retour, telle que le client la donne. */
    path: string | null;
    visitorId?: string | null;
    origin: string | null;
    ip: string;
    userAgent: string;
}

/**
 * Ce que la réception rend, et que la route traduit en réponse.
 *
 * `ignored` couvre tous les refus d'identité (clé inconnue, origine refusée,
 * site éteint, formulaire fermé, quota atteint) : ils se ressemblent tous
 * dehors, sans quoi l'endpoint dirait à qui le sonde quelles clés existent.
 *
 * `invalid` est la seule exception, et elle est délibérée : un envoi qui ne
 * colle pas au schéma est une propriété de la requête, pas un renseignement.
 * Il faut avoir une clé valide pour l'obtenir, et cette clé est publique, dans
 * la page. Sans ce retour, un site qui vient de renommer un champ n'aurait
 * aucun moyen de s'en apercevoir.
 */
export type SubmitOutcome =
    | { status: 'stored' }
    | { status: 'ignored' }
    | { status: 'failed' }
    | { status: 'invalid'; field: string; reason: ValidationReason };

interface CachedForm {
    id: number;
    mode: AudienceFormMode;
    fields: AudienceFormField[];
    open: boolean;
    submissions: number;
}

interface CachedSite {
    id: number;
    workspaceId: number;
    publicKey: string;
    platform: AudiencePlatform;
    visitorMode: AudienceVisitorMode;
    origins: string[];
    active: boolean;
    formsAuto: boolean;
    submissionIpQuota: number;
    formHourlyQuota: number;
    eventIpQuota: number;
}

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

interface CachedSession {
    id: number;
    lastAt: number;
    identityId: number | null;
}

const FLUSH_MS = 1000;

const MAINTENANCE_MS = 60 * 60 * 1000;

/**
 * Une diffusion `live` par espace au plus, sur cette période. Sans rapport avec
 * le plancher du hub : c'est un choix de produit, une audience se lit en
 * tendance et la rafraîchir plus souvent ne montrerait rien de plus.
 */
const BROADCAST_FLOOR_MS = 60_000;

/**
 * Plafond de la file : au-delà, on jette et on le dit. Sans lui, une base
 * indisponible transformerait la mémoire du processus en file sans fond, et le
 * serveur tomberait pour une feature qui n'est pas critique.
 */
const QUEUE_MAX = 20_000;
/** Fraîcheur du verdict de quota mensuel : l'ingestion ne lit pas la base à chaque vue. */
const PLAN_QUOTA_TTL_MS = 60_000;

/** Bornes des caches. Un dépassement vide, sans finesse : on recalcule. */
const LABEL_CACHE_MAX = 20_000;
const SESSION_CACHE_MAX = 20_000;
const UNKNOWN_KEY_CACHE_MAX = 1_000;
const EVENT_COUNT_CACHE_MAX = 50_000;

/**
 * Les deux paramètres de la dérivation du sel des visiteurs, fixes : le sel
 * doit être le même d'un redémarrage à l'autre.
 */
const VISITOR_SALT = 'audience';
const VISITOR_SALT_INFO = 'visitor-salt';

export class AudienceIngest {
    private readonly flushTicker: FeatureService;
    private readonly maintenanceTicker: FeatureService;
    private flushing = false;

    /**
     * Le secret d'où sortent les condensés de visiteurs : 32 octets dérivés de
     * la clé serveur (HKDF), jamais stockés ni écrits en base, et stables d'un
     * redémarrage à l'autre tant que la clé serveur ne change pas.
     */
    private readonly visitorSalt: string;

    /** `public_key` → site. Vidé à toute mutation d'un site (voir `invalidate`). */
    private readonly sites = new Map<string, CachedSite>();
    /**
     * Les clés qu'aucun site ne porte : sans cette mémoire, un client mal
     * configuré ou hostile ferait une requête SQL par événement pour toujours.
     * Bornée, parce qu'elle est alimentée par une entrée publique.
     */
    private readonly unknownKeys = new Set<string>();

    /** `siteId:kind:ref` → id du libellé. */
    private readonly labels = new Map<string, number>();
    /** `siteId:nameRef` → formulaire de retours. Vidé avec les sites. */
    private readonly forms = new Map<string, CachedForm>();
    /**
     * Le quota d'événements par adresse, compté **en mémoire**. Le chemin chaud
     * ne fait aucune requête, et lui en donner une par visite reviendrait à
     * défaire tout ce qui fait tenir l'ingestion. Une fenêtre approximative et
     * gratuite vaut mieux ici qu'une fenêtre exacte et coûteuse.
     */
    private readonly eventCounts = new Map<string, { from: number; count: number }>();
    /** Verdict du quota mensuel, par espace : voir `overPlanQuota`. */
    private readonly planQuota = new Map<number, { at: number; over: boolean }>();
    /** `siteId:visitorRef` → session ouverte. */
    private readonly sessions = new Map<string, CachedSession>();

    private queue: QueuedEvent[] = [];
    private dropped = 0;
    private readonly lastBroadcast = new Map<number, number>();

    constructor(private readonly deps: FeatureServiceDeps<AudienceRepo>) {
        this.visitorSalt = Buffer.from(deps.keys.derive(VISITOR_SALT, VISITOR_SALT_INFO, 32)).toString('hex');
        this.flushTicker = deps.createTicker({ intervalMs: FLUSH_MS, tick: () => this.flush() });
        this.maintenanceTicker = deps.createTicker({ intervalMs: MAINTENANCE_MS, tick: () => this.maintain() });
    }

    start(): void {
        this.flushTicker.start();
        this.maintenanceTicker.start();
        // Un premier ménage au démarrage : le seul moment où l'on est sûr de passer,
        // même sur une instance qui ne tourne qu'une heure par jour.
        setTimeout(() => void this.maintain(), 30_000).unref();
        this.deps.logger.info({ flushMs: FLUSH_MS }, 'Audience ingest started');
    }

    async stop(): Promise<void> {
        this.flushTicker.stop();
        this.maintenanceTicker.stop();
        // Une dernière vidange, attendue : l'hôte attend l'arrêt du module avant de
        // fermer le pool, donc lancée en `void` elle serait coupée par la fermeture.
        await this.flush();
    }

    /**
     * Oublie tout ce qu'on savait des sites ; appelé après toute mutation d'un
     * site. Vider en entier plutôt que cibler : la carte compte quelques
     * dizaines d'entrées, et une invalidation partielle laisse des périmés.
     */
    invalidate(): void {
        this.sites.clear();
        this.unknownKeys.clear();
        this.forms.clear();
    }

    /**
     * Accepte, ou ignore en silence, une requête d'ingestion. Ne lève jamais et
     * ne dit jamais non : l'appelant répond `204` quoi qu'il arrive, sans quoi
     * cet endpoint dirait à n'importe qui quelles clés existent.
     */
    async accept(req: IngestRequest): Promise<void> {
        const site = await this.resolveSite(req.key);
        if (!site || !site.active) return;
        if (!originAllowed(site.origins, req.origin, site.platform)) return;
        if (looksLikeBot(req.userAgent)) return;
        if (this.overEventQuota(site, req.ip)) return;
        if (await this.overPlanQuota(site.workspaceId)) return;

        const ua = parseUserAgent(req.userAgent);

        // Deux façons de reconnaître quelqu'un, et le réglage du site tranche. En
        // persistant, l'identifiant que le client garde rend la même personne
        // reconnaissable d'un jour à l'autre ; un client qui n'en envoie pas retombe
        // sur l'anonyme et ne sera jamais « déjà venu ».
        const persistent = site.visitorMode === 'persistent' && !!req.visitorId;
        const visitor = persistent
            ? persistentVisitorRef(this.visitorSalt, site.publicKey, req.visitorId as string)
            : visitorRef(this.dailySalt(), site.publicKey, req.ip, req.userAgent);
        const now = Math.floor(Date.now() / 1000);

        for (const event of req.events) {
            if (this.queue.length >= QUEUE_MAX) {
                this.dropped++;
                return;
            }
            const name = event.type === 'event' ? event.name?.trim() || null : null;
            // Un événement nommé sans nom produirait une ligne que rien ne désigne.
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
                // Ce que le client déclare l'emporte sur ce qu'on devine : un client natif
                // sait, là où le user-agent est une supposition.
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
     * Reçoit un retour.
     *
     * **Écrit avant de rendre la main**, contrairement à la mesure, et c'est la
     * seule divergence assumée entre les deux portes : une vue perdue au
     * redémarrage n'est rien, un message que personne ne lira l'est. Le débit
     * s'y prête, un retour n'arrivant pas à la cadence des pages vues.
     *
     * `looksLikeBot` ne s'applique pas non plus : un envoi depuis un serveur
     * porte le user-agent qu'il veut, et refuser sur cette heuristique
     * avalerait des messages réels. Le pot de miel, les origines et les quotas
     * sont les gardes.
     *
     * Trois refus, et un seul parle. `ignored` couvre tout ce qui touche à
     * l'identité (clé, origine, site éteint, formulaire fermé, quota) et se
     * ressemble vu de dehors, sans quoi l'endpoint dirait à qui le sonde
     * quelles clés existent. `invalid` nomme le champ fautif, parce qu'il faut
     * déjà une clé valide pour l'obtenir, que cette clé est publique dans la
     * page, et qu'un site qui vient de renommer un champ doit pouvoir s'en
     * apercevoir. `failed` avoue la panne, sans quoi le site annoncerait
     * « message envoyé » sur un message perdu.
     */
    async submit(req: SubmitRequest): Promise<SubmitOutcome> {
        let site: CachedSite | null;
        let form: CachedForm | null;
        let cipher: SdkCipher;
        try {
            site = await this.resolveSite(req.key);
            if (!site || !site.active) return { status: 'ignored' };
            if (!originAllowed(site.origins, req.origin, site.platform)) return { status: 'ignored' };

            cipher = this.deps.cipherFor(site.workspaceId);
            form = await this.resolveForm(site, req.form, cipher);
        } catch (e) {
            this.deps.logger.error({ err: e }, 'Audience submit: form lookup failed');
            return { status: 'failed' };
        }
        if (!form || !form.open) return { status: 'ignored' };
        // Plein, on cesse d'accepter au lieu d'effacer le plus ancien : ce que le
        // site a demandé à collecter ne disparaît pas pour faire de la place.
        if (form.submissions >= AUDIENCE_FORM_SUBMISSIONS_MAX) {
            await this.closeForm(form, 'full');
            return { status: 'ignored' };
        }

        // La validation avant tout le reste : refuser coûte moins qu'un chiffrement
        // et une écriture, et le verdict ne dépend de rien d'autre que du schéma.
        let fields = req.fields;
        if (form.mode === 'strict') {
            const checked = validateSubmission(form.fields, req.fields);
            if (!checked.ok) return { status: 'invalid', field: checked.field, reason: checked.reason };
            fields = checked.fields;
        }

        const now = Math.floor(Date.now() / 1000);
        try {
            // L'adresse ne sert qu'à compter et n'est jamais conservée : le même
            // condensé salé au jour que pour un visiteur, sans le user-agent.
            const ip = visitorRef(this.dailySalt(), site.publicKey, req.ip, '');
            if (await this.overQuota(site, form, ip, now)) return { status: 'ignored' };

            const persistent = site.visitorMode === 'persistent' && !!req.visitorId;
            const visitor = persistent
                ? persistentVisitorRef(this.visitorSalt, site.publicKey, req.visitorId as string)
                : visitorRef(this.dailySalt(), site.publicKey, req.ip, req.userAgent);
            // La visite d'où vient le retour, si elle est encore ouverte. Jamais
            // créée : un retour n'est pas une visite, et en ouvrir une ici gonflerait
            // les chiffres de fréquentation d'un site qui ne pose pas la balise.
            const session = await this.deps.repo.findOpenSession(site.id, visitor, now - AUDIENCE_SESSION_GAP_SECONDS);

            const path = req.path ? normalizePath(req.path) : '';
            await this.deps.repo.insertSubmission({
                formId: form.id,
                siteId: site.id,
                ts: now,
                ipRef: ip,
                sessionId: session?.id ?? null,
                content: await cipher.encrypt(JSON.stringify({ fields, path }))
            });
            await countAnswers(this.deps.repo, cipher, form.id, fields, 1);
            await this.deps.repo.touchForm(form.id, now);
            form.submissions++;
            this.maybeBroadcast(site.workspaceId);
            return { status: 'stored' };
        } catch (e) {
            this.deps.logger.error({ err: e, siteId: site.id }, 'Audience submit failed');
            return { status: 'failed' };
        }
    }

    /**
     * Les deux quotas de la dernière heure, en fenêtre glissante : celui d'une
     * provenance sur ce formulaire, puis celui du formulaire toutes provenances
     * confondues. Le motif du plafond horaire des signalements du socle, un
     * `COUNT(*)` servi par un index composite, sans table de compteurs ni
     * fenêtre à purger.
     *
     * Le second **ferme** le formulaire : un flot distribué ne s'essouffle pas
     * tout seul, et une porte close et datée vaut mieux qu'un canal rempli
     * jusqu'au plafond de stockage, qu'il faudrait alors vider à la main.
     *
     * Deux requêtes par retour : abordable ici, impensable sur le chemin de la
     * mesure, d'où le compteur en mémoire de celle-ci.
     */
    private async overQuota(site: CachedSite, form: CachedForm, ip: string, now: number): Promise<boolean> {
        const since = now - 3600;
        if (site.submissionIpQuota > 0) {
            const fromIp = await this.deps.repo.countSubmissionsSince(form.id, ip, since);
            if (fromIp >= site.submissionIpQuota) return true;
        }
        if (site.formHourlyQuota > 0) {
            const total = await this.deps.repo.countSubmissionsSince(form.id, null, since);
            if (total >= site.formHourlyQuota) {
                await this.closeForm(form, 'quota');
                return true;
            }
        }
        return false;
    }

    /** Ferme un formulaire de son propre chef, en base et dans le cache. */
    private async closeForm(form: CachedForm, reason: 'quota' | 'full'): Promise<void> {
        if (!form.open) return;
        form.open = false;
        await this.deps.repo.closeForm(form.id, Math.floor(Date.now() / 1000), reason);
        this.deps.logger.warn({ formId: form.id, reason }, 'Audience form closed automatically');
    }

    /**
     * Le formulaire de ce nom. Créé à la volée **seulement si le site
     * l'autorise** : c'est ce réglage qui prête l'interface à qui lit la clé
     * publique dans la page, et il est éteint par défaut. Le plafond borne ce
     * qu'il peut faire apparaître même allumé.
     */
    private async resolveForm(site: CachedSite, name: string, cipher: SdkCipher): Promise<CachedForm | null> {
        const trimmed = name.trim();
        const ref = nameRef(trimmed);
        const cacheKey = `${site.id}:${ref}`;
        const cached = this.forms.get(cacheKey);
        if (cached) return cached;

        const existing = await this.deps.repo.findFormByName(site.id, ref);
        if (existing) {
            const stored = await readJson<{ fields?: AudienceFormField[] }>(cipher, existing.form_schema);
            const form: CachedForm = {
                id: Number(existing.id),
                mode: existing.mode === 'strict' ? 'strict' : 'auto',
                // Un schéma illisible ne fait pas passer un formulaire strict pour
                // permissif : sans champs déclarés, la validation refuse tout, ce qui
                // est le bon sens du doute.
                fields: stored?.fields ?? [],
                open: Number(existing.is_open) === 1,
                submissions: Number(existing.submissions)
            };
            this.forms.set(cacheKey, form);
            return form;
        }

        if (!site.formsAuto) return null;
        const count = await this.deps.repo.countForms(site.id);
        if (count >= AUDIENCE_MAX_FORMS) return null;
        const id = await this.deps.repo.createForm({
            siteId: site.id,
            nameRef: ref,
            content: await cipher.encrypt(trimmed),
            mode: 'auto',
            formSchema: null,
            sortOrder: count
        });
        const form: CachedForm = { id, mode: 'auto', fields: [], open: true, submissions: 0 };
        this.forms.set(cacheKey, form);
        return form;
    }

    /**
     * Le plafond d'événements d'une adresse sur ce site, **en mémoire**.
     *
     * Le chemin chaud ne fait aucune requête, et c'est ce qui lui permet de
     * tenir la cadence des visites de tous les sites : lui en donner une par
     * événement défairait tout le reste. Le prix est assumé et dit à l'écran,
     * la fenêtre étant approximative (elle repart d'un bloc, elle ne glisse
     * pas) et remise à zéro au redémarrage.
     *
     * Éteint par défaut (`0`), pour qu'aucun site déjà branché ne se mette à
     * perdre des vues sans qu'on l'ait demandé.
     */
    /**
     * L'offre du propriétaire de l'espace borne les vues du mois en cours. Lu
     * dans l'agrégat journalier, jamais dans les événements bruts : une seule
     * requête indexée, dont le retard vaut au plus un tour de ménage.
     *
     * Le verdict est gardé une minute : l'ingestion est la voie la plus chaude
     * de l'app, elle ne peut pas interroger la base à chaque vue.
     */
    private async overPlanQuota(workspaceId: number): Promise<boolean> {
        const cached = this.planQuota.get(workspaceId);
        if (cached && Date.now() - cached.at < PLAN_QUOTA_TTL_MS) return cached.over;
        const month = new Date();
        const fromDay = month.getUTCFullYear() * 10000 + (month.getUTCMonth() + 1) * 100 + 1;
        let over = false;
        try {
            await this.deps
                .quotaFor(workspaceId)
                .assert('events', (owned) => this.deps.repo.eventsSince(owned, fromDay));
        } catch (e) {
            over = e instanceof FeatureError && e.code === 'quota_exceeded';
            if (!over) {
                // Une offre illisible ne doit pas arrêter l'ingestion de tout le monde.
                this.deps.logger.error({ err: (e as Error).message, workspaceId }, 'Audience: offre illisible');
            } else if (!cached?.over) {
                this.deps.logger.warn({ workspaceId }, 'Audience: quota mensuel atteint, ingestion suspendue');
            }
        }
        this.planQuota.set(workspaceId, { at: Date.now(), over });
        return over;
    }

    private overEventQuota(site: CachedSite, ip: string): boolean {
        if (site.eventIpQuota <= 0) return false;

        const now = Date.now();
        const key = `${site.id}:${ip}`;
        const seen = this.eventCounts.get(key);
        if (!seen || now - seen.from >= 3600_000) {
            // Bornée par une entrée publique, donc vidée sans finesse : on
            // recommence à compter plutôt que de laisser la carte enfler.
            if (this.eventCounts.size >= EVENT_COUNT_CACHE_MAX) this.eventCounts.clear();
            this.eventCounts.set(key, { from: now, count: 1 });
            return false;
        }
        seen.count++;
        return seen.count > site.eventIpQuota;
    }

    /**
     * Le sel du jour, dérivé d'un secret du serveur et de la date UTC. Dérivé
     * et non tiré au sort au démarrage, sinon un redémarrage compterait deux
     * fois chaque visiteur du jour ; tournant, pour qu'aucun identifiant ne
     * suive quelqu'un d'un jour à l'autre.
     */
    private dailySalt(): string {
        return `${this.visitorSalt}:${dayKey(Math.floor(Date.now() / 1000))}`;
    }

    /**
     * L'horodatage retenu. Un client peut en proposer un (pour livrer ce qu'il
     * a mis de côté hors ligne), borné aux dernières 24 heures : une horloge
     * fausse ne doit pas dater une visite de 2038 et écraser l'échelle des
     * graphes.
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
            row = await this.deps.repo.findByPublicKey(key);
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
            active: Number(row.active) === 1,
            formsAuto: Number(row.forms_auto) === 1,
            submissionIpQuota: Number(row.submission_ip_quota),
            formHourlyQuota: Number(row.form_hourly_quota),
            eventIpQuota: Number(row.event_ip_quota)
        };
        this.sites.set(key, site);
        return site;
    }

    /**
     * L'identifiant d'un libellé, du cache ou de la base. Sans le cache, chaque
     * visite ferait un aller-retour SQL et un chiffrement par dimension.
     */
    private async resolveLabel(siteId: number, kind: string, value: string, cipher: SdkCipher): Promise<number> {
        const ref = labelRef(value);
        const cacheKey = `${siteId}:${kind}:${ref}`;
        const hit = this.labels.get(cacheKey);
        if (hit !== undefined) return hit;

        const content = await cipher.encrypt(value);
        const id = await this.deps.repo.resolveLabel(siteId, kind, ref, content);
        if (this.labels.size >= LABEL_CACHE_MAX) this.labels.clear();
        this.labels.set(cacheKey, id);
        return id;
    }

    /** `undefined` en entrée = pas de dimension, donc pas de libellé. */
    private async resolveOptional(
        siteId: number,
        kind: string,
        value: string | null,
        cipher: SdkCipher
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
                const cipher = this.deps.cipherFor(item.workspaceId);
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

                // Une identité qui apparaît en cours de route rattache la session déjà
                // ouverte : on arrive anonyme, on se connecte, et sans ceci toute visite
                // resterait anonyme jusqu'à la suivante.
                if (item.identity && session.identityId === null) {
                    const identityId = await this.resolveLabel(item.siteId, 'identity', item.identity, cipher);
                    await this.deps.repo.setSessionIdentity(session.id, identityId);
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

            await this.deps.repo.insertEvents(events);
            for (const [sessionId, delta] of touched) {
                await this.deps.repo.touchSession(sessionId, delta.lastAt, delta.views);
            }
            for (const [siteId, at] of siteLastAt) {
                await this.deps.repo.touchSite(siteId, at);
            }
            for (const workspaceId of workspaces) this.maybeBroadcast(workspaceId);
        } catch (e) {
            // La file a déjà été vidée : ce lot est perdu, et c'est voulu. Le remettre en
            // tête ferait boucler sur une écriture qui échoue, en accumulant la suite.
            this.deps.logger.error({ err: e, events: batch.length }, 'Audience ingest: flush failed');
        } finally {
            this.flushing = false;
        }
    }

    private async resolveSession(item: QueuedEvent, cipher: SdkCipher): Promise<CachedSession> {
        const cacheKey = `${item.siteId}:${item.visitorRef}`;
        const cached = this.sessions.get(cacheKey);
        if (cached && item.ts - cached.lastAt < AUDIENCE_SESSION_GAP_SECONDS) return cached;

        const since = item.ts - AUDIENCE_SESSION_GAP_SECONDS;
        const open = await this.deps.repo.findOpenSession(item.siteId, item.visitorRef, since);
        if (open) {
            const session: CachedSession = { id: open.id, lastAt: item.ts, identityId: open.identity_id };
            this.remember(cacheKey, session);
            return session;
        }

        // Les dimensions d'une session sont posées à son ouverture et n'en bougent plus :
        // elles décrivent une visite, pas un instant. L'identité fait exception, parce
        // qu'elle arrive après coup par construction.
        const id = await this.deps.repo.createSession({
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
        // Le sujet du module, diffusé par le hub, projections comprises.
        this.deps.live.changed(workspaceId);
    }

    /**
     * Le ménage horaire : agrégat, rétention, libellés orphelins. L'agrégat est
     * refait pour hier et aujourd'hui : aujourd'hui bouge encore, et rien ne
     * garantit qu'une instance tournait à minuit, alors qu'un jour manquant est
     * un trou définitif dès que les événements bruts ont expiré.
     */
    private async maintain(): Promise<void> {
        try {
            const now = Math.floor(Date.now() / 1000);
            const sites = await this.deps.repo.listForMaintenance();

            for (const site of sites) {
                for (const at of [now - 86400, now]) {
                    const { from, to } = dayBounds(at);
                    await this.deps.repo.rollupDay(site.id, dayKey(at), from, to);
                }

                const before = now - site.retention_days * 86400;
                const events = await this.deps.repo.pruneEvents(site.id, before);
                const sessions = await this.deps.repo.pruneSessions(site.id, before);
                if (events + sessions > 0) {
                    // Les libellés ne sont balayés que si quelque chose a réellement
                    // disparu : la requête parcourt deux tables de faits.
                    const labels = await this.deps.repo.pruneOrphanLabels(site.id);
                    this.deps.logger.info({ siteId: site.id, events, sessions, labels }, 'Audience retention sweep');
                    // Des identifiants viennent de disparaître : le cache les rendrait
                    // encore, et l'insertion suivante buterait sur une clé étrangère morte.
                    this.labels.clear();
                    this.sessions.clear();
                }
            }
        } catch (e) {
            this.deps.logger.error({ err: e }, 'Audience ingest: maintenance failed');
        }
    }
}
