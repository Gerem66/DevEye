import { createHmac } from 'node:crypto';

import {
    normalizeReferrer,
    parseUserAgent,
    visitorRef,
    type FeatureService,
    type FeatureServiceDeps
} from '@deveye/types/sdk/server';

import { SHORTLINK_REFERRER_MAX } from '../contracts/domain';
import { dayOf, monthOf, now } from './_shared';
import type { DailyDelta, DimDelta, ShortlinksRepo } from './repo';

/**
 * Ce que compte une redirection, sans jamais écrire sur le chemin chaud : les
 * passages s'accumulent en mémoire et se vident chaque seconde. Une visite est
 * une personne par lien et par jour UTC : la table `seen` en fait foi, la
 * mémoire du jour ne sert qu'à éviter de la consulter pour quelqu'un déjà
 * compté. L'adresse IP n'entre que dans l'empreinte et dans le pays, puis s'oublie.
 */

/** Au-delà, la mémoire du jour repart de zéro : la base reste la vérité. */
const SEEN_MEMORY_MAX = 200_000;
/** Ce que la file garde entre deux vidages ; le surplus se perd plutôt que d'épuiser la mémoire. */
const QUEUE_MAX = 50_000;
/** L'usage de l'offre relu au plus une fois par minute et par espace. */
const USAGE_TTL_MS = 60_000;
/** Une liste ouverte se relit au plus une fois par minute pendant que les visites arrivent. */
const BROADCAST_FLOOR_MS = 60_000;
/** Les seuils d'avis de la limite mensuelle. */
const NOTICE_LEVELS = [80, 100] as const;

export interface Visit {
    linkId: number;
    workspaceId: number;
    ip: string;
    userAgent: string;
    referrer: string | undefined;
    acceptLanguage: string | undefined;
    /** Les hôtes qui servent ce lien : venir de l'un d'eux n'est pas un site d'origine. */
    ownHosts: readonly string[];
}

interface Candidate {
    linkId: number;
    workspaceId: number;
    day: number;
    ref: string;
    country: string;
    device: string;
    browser: string;
    os: string;
    language: string;
    referrer: string | null;
}

interface UsageEntry {
    limit: number | null;
    used: number;
    expires: number;
}

/** La langue principale déclarée par le navigateur, en code court (`fr`) ; vide si illisible. */
export function primaryLanguage(header: string | undefined): string {
    const first = (header ?? '').split(',')[0]?.trim().toLowerCase() ?? '';
    const code = first.split(/[-;]/)[0] ?? '';
    return /^[a-z]{2,3}$/.test(code) ? code : '';
}

export class Counters {
    private readonly visitorSalt: string;
    private readonly labelKey: Buffer;
    private seenDay = dayOf(now());
    private seen = new Set<string>();
    private clicks = new Map<string, DailyDelta>();
    private candidates: Candidate[] = [];
    private pendingByWorkspace = new Map<number, number>();
    private pendingByLink = new Map<number, number>();
    private usage = new Map<number, UsageEntry>();
    private usageReads = new Map<number, Promise<UsageEntry>>();
    private labels = new Map<string, number>();
    private broadcastAt = new Map<number, number>();
    private dropped = 0;

    constructor(private readonly deps: FeatureServiceDeps<ShortlinksRepo>) {
        this.visitorSalt = Buffer.from(deps.keys.derive('shortlinks', 'visitor-salt', 32)).toString('hex');
        this.labelKey = Buffer.from(deps.keys.derive('shortlinks', 'label-ref', 32));
    }

    /** Les visites comptées ici et pas encore écrites. */
    pendingVisits(workspaceId: number): number {
        return this.pendingByWorkspace.get(workspaceId) ?? 0;
    }

    pendingLinkVisits(linkId: number): number {
        return this.pendingByLink.get(linkId) ?? 0;
    }

    /**
     * Le mois de l'offre laisse-t-il encore passer une visite pour cet espace ?
     * Lu en cache, une relecture à la fois ; un fournisseur d'offre en panne
     * laisse passer, comme pour une création.
     */
    async allows(workspaceId: number): Promise<boolean> {
        const entry = await this.usageOf(workspaceId);
        return entry.limit === null || entry.used < entry.limit;
    }

    private usageOf(workspaceId: number): Promise<UsageEntry> {
        const hit = this.usage.get(workspaceId);
        if (hit && hit.expires > Date.now()) return Promise.resolve(hit);
        const running = this.usageReads.get(workspaceId);
        if (running) return running;
        const read = (async () => {
            let entry: UsageEntry;
            try {
                const use = await this.deps.quotaFor(workspaceId).usage('visits');
                entry = {
                    limit: use?.limit ?? null,
                    used: (use?.used ?? 0) + this.pendingVisits(workspaceId),
                    expires: Date.now() + USAGE_TTL_MS
                };
            } catch (error) {
                this.deps.logger.warn(
                    { err: error, workspaceId },
                    'shortlinks: offre illisible, visites laissées passer'
                );
                entry = { limit: null, used: 0, expires: Date.now() + USAGE_TTL_MS };
            }
            this.usage.set(workspaceId, entry);
            return entry;
        })();
        this.usageReads.set(workspaceId, read);
        const settle = () => this.usageReads.delete(workspaceId);
        read.then(settle, settle);
        return read;
    }

    /** Un passage de robot : redirigé, compté à part, jamais une visite. */
    recordBot(linkId: number): void {
        this.bump(linkId, dayOf(now()), 0, 1);
    }

    /** Un passage humain : une ouverture toujours, une visite si la personne est nouvelle aujourd'hui. */
    record(visit: Visit, country: string | null): void {
        const day = this.rollDay();
        this.bump(visit.linkId, day, 1, 0);
        const ref = visitorRef(`${this.visitorSalt}:${day}`, String(visit.linkId), visit.ip, visit.userAgent);
        const key = `${visit.linkId}:${ref}`;
        if (this.seen.has(key)) return;
        if (this.candidates.length >= QUEUE_MAX) {
            this.dropped++;
            return;
        }
        if (this.seen.size >= SEEN_MEMORY_MAX) this.seen.clear();
        this.seen.add(key);
        const agent = parseUserAgent(visit.userAgent);
        this.candidates.push({
            linkId: visit.linkId,
            workspaceId: visit.workspaceId,
            day,
            ref,
            country: country ?? '',
            device: agent.device,
            browser: agent.browser ?? '',
            os: agent.os ?? '',
            language: primaryLanguage(visit.acceptLanguage),
            referrer: normalizeReferrer(visit.referrer, visit.ownHosts, SHORTLINK_REFERRER_MAX)
        });
        this.pendingByWorkspace.set(visit.workspaceId, this.pendingVisits(visit.workspaceId) + 1);
        this.pendingByLink.set(visit.linkId, this.pendingLinkVisits(visit.linkId) + 1);
        const usage = this.usage.get(visit.workspaceId);
        if (usage) usage.used++;
    }

    private rollDay(): number {
        const day = dayOf(now());
        if (day !== this.seenDay) {
            this.seenDay = day;
            this.seen.clear();
        }
        return day;
    }

    private bump(linkId: number, day: number, clicks: number, bots: number): void {
        const key = `${linkId}:${day}`;
        const row = this.clicks.get(key) ?? { linkId, day, clicks: 0, visits: 0, bots: 0 };
        row.clicks += clicks;
        row.bots += bots;
        this.clicks.set(key, row);
    }

    /** L'étiquette chiffrée d'un site d'origine, créée au besoin, dans l'espace du lien. */
    private async referrerLabel(workspaceId: number, host: string): Promise<number> {
        const cacheKey = `${workspaceId}:${host}`;
        const hit = this.labels.get(cacheKey);
        if (hit !== undefined) return hit;
        const ref = createHmac('sha256', this.labelKey).update(host).digest('hex').slice(0, 32);
        const content = await this.deps.cipherFor(workspaceId).encrypt(host);
        const id = await this.deps.repo.counters.resolveLabel(workspaceId, 'referrer', ref, content);
        if (this.labels.size >= 20_000) this.labels.clear();
        this.labels.set(cacheKey, id);
        return id;
    }

    /** Écrit ce qui s'est accumulé depuis le dernier vidage. */
    async flush(): Promise<void> {
        const clicks = this.clicks;
        const candidates = this.candidates;
        this.clicks = new Map();
        this.candidates = [];
        if (this.dropped > 0) {
            this.deps.logger.warn({ dropped: this.dropped }, 'shortlinks: visites perdues, file pleine');
            this.dropped = 0;
        }
        if (clicks.size === 0 && candidates.length === 0) return;

        const repo = this.deps.repo;
        const dims: DimDelta[] = [];
        const visitsByLink = new Map<number, number>();
        const visitsByWorkspace = new Map<number, number>();
        const touched = new Set<number>();
        try {
            for (const candidate of candidates) {
                if (!(await repo.counters.markSeen(candidate.day, candidate.linkId, candidate.ref))) continue;
                const key = `${candidate.linkId}:${candidate.day}`;
                const row = clicks.get(key) ?? {
                    linkId: candidate.linkId,
                    day: candidate.day,
                    clicks: 0,
                    visits: 0,
                    bots: 0
                };
                row.visits++;
                clicks.set(key, row);
                visitsByLink.set(candidate.linkId, (visitsByLink.get(candidate.linkId) ?? 0) + 1);
                visitsByWorkspace.set(candidate.workspaceId, (visitsByWorkspace.get(candidate.workspaceId) ?? 0) + 1);
                const referrer =
                    candidate.referrer === null
                        ? ''
                        : String(await this.referrerLabel(candidate.workspaceId, candidate.referrer));
                const values: [string, string][] = [
                    ['country', candidate.country],
                    ['device', candidate.device],
                    ['browser', candidate.browser],
                    ['os', candidate.os],
                    ['language', candidate.language],
                    ['referrer', referrer]
                ];
                for (const [kind, value] of values) {
                    dims.push({ linkId: candidate.linkId, day: candidate.day, kind, value, visits: 1 });
                }
            }
            await repo.counters.addDaily([...clicks.values()]);
            await repo.counters.addDims(mergeDims(dims));
            const linkTotals = new Map<number, { clicks: number; visits: number }>();
            for (const row of clicks.values()) {
                const total = linkTotals.get(row.linkId) ?? { clicks: 0, visits: 0 };
                total.clicks += row.clicks;
                total.visits += row.visits;
                linkTotals.set(row.linkId, total);
            }
            for (const [linkId, total] of linkTotals) {
                if (total.clicks > 0 || total.visits > 0)
                    await repo.links.addTotals(linkId, total.clicks, total.visits);
            }
            const month = monthOf(now());
            for (const [workspaceId, visits] of visitsByWorkspace) {
                const usage = await repo.counters.addUsage(workspaceId, month, visits);
                await this.maybeNotify(workspaceId, month, usage.notified);
                touched.add(workspaceId);
            }
        } catch (error) {
            this.deps.logger.error({ err: error }, 'shortlinks: compteurs non écrits');
        } finally {
            for (const candidate of candidates) {
                this.decrement(this.pendingByWorkspace, candidate.workspaceId);
                this.decrement(this.pendingByLink, candidate.linkId);
            }
        }
        for (const workspaceId of touched) this.maybeBroadcast(workspaceId);
    }

    private decrement(map: Map<number, number>, key: number): void {
        const left = (map.get(key) ?? 0) - 1;
        if (left > 0) map.set(key, left);
        else map.delete(key);
    }

    private maybeBroadcast(workspaceId: number): void {
        const last = this.broadcastAt.get(workspaceId) ?? 0;
        if (Date.now() - last < BROADCAST_FLOOR_MS) return;
        this.broadcastAt.set(workspaceId, Date.now());
        this.deps.live.changed(workspaceId, ['shortlinksStats']);
    }

    /**
     * Un avis par seuil franchi et par mois : à 80 %, pour avoir le temps d'agir,
     * puis à la limite, quand les liens cessent de rediriger. La limite est celle
     * du propriétaire de l'espace, sur tous ses espaces.
     */
    private async maybeNotify(workspaceId: number, month: string, notified: number): Promise<void> {
        if (notified >= 100) return;
        let use: { used: number; limit: number } | null;
        try {
            use = await this.deps.quotaFor(workspaceId).usage('visits');
        } catch {
            return;
        }
        if (use === null) return;
        const entry = this.usage.get(workspaceId);
        if (entry) entry.used = use.used + this.pendingVisits(workspaceId);
        const percent = use.limit === 0 ? 100 : (use.used / use.limit) * 100;
        const level = [...NOTICE_LEVELS].reverse().find((threshold) => percent >= threshold);
        if (level === undefined || level <= notified) return;
        await this.deps.repo.counters.setNotified(workspaceId, month, level);
        const alert =
            level === 100
                ? {
                      subject: 'Liens courts : limite de visites atteinte',
                      body: `Vos liens ont reçu ${use.used} visites ce mois-ci, la limite de votre offre (${use.limit}). Jusqu’au début du mois prochain, ils affichent une page « momentanément indisponible » au lieu de rediriger. Passez à une offre supérieure pour les rétablir tout de suite.`
                  }
                : {
                      subject: 'Liens courts : 80 % des visites du mois',
                      body: `Vos liens ont reçu ${use.used} visites ce mois-ci, sur ${use.limit} permises par votre offre. À la limite, ils afficheront une page « momentanément indisponible » jusqu’au début du mois prochain.`
                  };
        try {
            await this.deps.deveyeFor(workspaceId).notify.send(alert);
        } catch (error) {
            this.deps.logger.warn({ err: error, workspaceId }, 'shortlinks: avis de limite non parti');
        }
    }

    /** Le tour quotidien : oublier les empreintes des jours passés et les ventilations trop anciennes. */
    async prune(dimsDays: number): Promise<void> {
        const today = dayOf(now());
        await this.deps.repo.counters.purgeSeen(today);
        await this.deps.repo.counters.purgeDims(today - dimsDays);
    }

    service(): FeatureService {
        return this.deps.createTicker({ intervalMs: 1_000, tick: () => this.flush() });
    }
}

/** Une ligne par lien, jour, dimension et valeur : la base reçoit des sommes, pas des unités. */
export function mergeDims(rows: readonly DimDelta[]): DimDelta[] {
    const merged = new Map<string, DimDelta>();
    for (const row of rows) {
        const key = `${row.linkId}:${row.day}:${row.kind}:${row.value}`;
        const hit = merged.get(key);
        if (hit) hit.visits += row.visits;
        else merged.set(key, { ...row });
    }
    return [...merged.values()];
}
