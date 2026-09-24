import {
    err,
    MAINTENANCE_CLOSE_CODE,
    MAINTENANCE_EVENT,
    type AdminMaintenance,
    type FeatureMaintenanceLevel,
    type MaintenanceState,
    type PublicMaintenance
} from '@deveye/types';

import type { FastifyReply, FastifyRequest } from 'fastify';

import type { Database } from '@/db';
import type { LiveHub } from '@/live/hub';
import type { logger as appLogger } from '@/logger';
import { env } from '@/Utils/Env';

export const DEFAULT_SITE_MESSAGE =
    'DevEye est en maintenance pour quelques instants. Cette page se rechargera d’elle-même dès notre retour.';

export const FEATURE_MAINTENANCE_MESSAGE = 'Cette fonctionnalité est en maintenance. Réessayez un peu plus tard.';

/** Relecture de la base : ce qu'on y écrit à la main s'applique sans redémarrage. */
const POLL_MS = 15_000;

/** Les services des modules, vus de la maintenance : `full` les arrête et les relance. */
export interface MaintenanceServices {
    /** Les modules installés : une ligne pour un module retiré ne compte pas. */
    installed(): readonly string[];
    hasService(featureId: string): boolean;
    stop(featureId: string): Promise<void>;
    start(featureId: string): Promise<void>;
}

interface Deps {
    db: Database;
    live: LiveHub;
    logger: typeof appLogger;
    services: MaintenanceServices;
}

interface Snapshot {
    site: boolean;
    message: string | null;
    features: ReadonlyMap<string, FeatureMaintenanceLevel>;
}

/** Un refus d'entrée pendant la maintenance du site, rendu en 503 par l'app. */
export class MaintenanceError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'MaintenanceError';
    }
}

const sameSnapshot = (a: Snapshot, b: Snapshot): boolean =>
    a.site === b.site &&
    a.message === b.message &&
    a.features.size === b.features.size &&
    [...a.features].every(([id, level]) => b.features.get(id) === level);

/**
 * L'état de maintenance du processus, lu de façon synchrone par les gardes
 * (dispatcheur WS, routes d'auth et routes publiques des modules). La base fait
 * foi : l'interface y écrit, la relecture périodique y reprend ce qu'on a
 * modifié à la main, et chaque changement passe par `apply`, une seule fois.
 */
class MaintenanceStore {
    private current: Snapshot = { site: false, message: null, features: new Map() };
    private deps: Deps | null = null;
    // Les changements d'état s'appliquent l'un après l'autre.
    private chain: Promise<unknown> = Promise.resolve();
    // Les arrêts et relances d'une feature aussi, mais dans une file à elle : un
    // service lent à s'arrêter ne retarde pas la fermeture du site demandée après.
    private readonly transitions = new Map<string, Promise<void>>();
    private poll: ReturnType<typeof setInterval> | null = null;
    private warned = new Set<string>();

    /** Avant le démarrage des services et l'écoute : personne n'entre sur un état non lu. */
    async init(deps: Deps): Promise<void> {
        this.deps = deps;
        if (env.MAINTENANCE) {
            await deps.db.maintenance.seedFromEnv();
            deps.logger.warn('MAINTENANCE=1 : le site démarre en maintenance');
        }
        this.current = await this.read();
        this.poll = setInterval(() => void this.reload(), POLL_MS);
        this.poll.unref();
    }

    /** À l'arrêt du processus : un arrêt ou une relance en vol finit avant celui des services. */
    async close(): Promise<void> {
        if (this.poll) clearInterval(this.poll);
        this.poll = null;
        await Promise.allSettled(this.transitions.values());
    }

    siteDown(): boolean {
        return this.current.site;
    }

    message(): string {
        return this.current.message ?? DEFAULT_SITE_MESSAGE;
    }

    featureLevel(featureId: string): FeatureMaintenanceLevel | null {
        return this.current.features.get(featureId) ?? null;
    }

    /** L'arrêt complet refuse aussi l'administrateur : la feature ne sait plus répondre. */
    refuses(featureId: string, isAdmin: boolean): boolean {
        const level = this.featureLevel(featureId);
        return level === 'full' || (level === 'requests' && !isAdmin);
    }

    /**
     * Une route publique de cette feature. Celles réservées à l'origine de l'app
     * prolongent une commande déjà gardée (ticket, retour OAuth) et passent,
     * sauf à l'arrêt complet où plus rien ne répond derrière.
     */
    refusesPublic(featureId: string, appOnly: boolean): boolean {
        const level = this.featureLevel(featureId);
        if (level === 'full') return true;
        return !appOnly && (this.current.site || level !== null);
    }

    clientState(): MaintenanceState {
        return {
            site: this.current.site,
            message: this.message(),
            features: Object.fromEntries(this.current.features)
        };
    }

    publicState(): PublicMaintenance {
        return { site: this.current.site, message: this.message() };
    }

    /**
     * Le rappel des administrateurs : démarré sous `MAINTENANCE=1`, pas encore
     * fermé. Le client ne l'affiche qu'une fois la maintenance levée.
     */
    async envNotice(): Promise<boolean> {
        if (!env.MAINTENANCE) return false;
        const site = await this.need().db.maintenance.site();
        return !site.envNoticeDismissed;
    }

    async adminState(): Promise<AdminMaintenance> {
        const { db, services } = this.need();
        const [site, rows] = await Promise.all([db.maintenance.site(), db.maintenance.features()]);
        const byId = new Map(rows.map((r) => [r.feature, r]));
        return {
            site: {
                active: site.active,
                message: site.message,
                defaultMessage: DEFAULT_SITE_MESSAGE,
                envSeeded: env.MAINTENANCE,
                updated: site.updated,
                updatedBy: site.updatedBy
            },
            features: services.installed().map((id) => {
                const row = byId.get(id);
                return {
                    id,
                    level: row?.level ?? null,
                    hasService: services.hasService(id),
                    updated: row?.updated ?? null,
                    updatedBy: row?.updatedBy ?? null
                };
            })
        };
    }

    async setSite(active: boolean, message: string | null, by: number): Promise<void> {
        const { settled } = await this.enqueue(async () => {
            await this.need().db.maintenance.setSite(active, message, by);
            return this.apply(await this.read());
        });
        await settled;
    }

    /** Rend la main une fois le service de la feature arrêté ou relancé, s'il y a lieu. */
    async setFeature(featureId: string, level: FeatureMaintenanceLevel | null, by: number): Promise<void> {
        const { settled } = await this.enqueue(async () => {
            await this.need().db.maintenance.setFeature(featureId, level, by);
            return this.apply(await this.read());
        });
        await settled;
    }

    async dismissEnvNotice(): Promise<void> {
        await this.need().db.maintenance.dismissEnvNotice();
    }

    private async reload(): Promise<void> {
        try {
            await this.enqueue(async () => this.apply(await this.read()));
        } catch (error) {
            this.deps?.logger.warn({ err: error }, 'maintenance : relecture de la base en échec');
        }
    }

    private enqueue<T>(fn: () => Promise<T>): Promise<T> {
        const run = this.chain.then(fn, fn);
        this.chain = run.catch(() => undefined);
        return run;
    }

    private need(): Deps {
        if (!this.deps) throw new Error('maintenance : init() manquant au boot');
        return this.deps;
    }

    private async read(): Promise<Snapshot> {
        const { db, services, logger } = this.need();
        const [site, rows] = await Promise.all([db.maintenance.site(), db.maintenance.features()]);
        const installed = new Set(services.installed());
        const features = new Map<string, FeatureMaintenanceLevel>();
        for (const row of rows) {
            if (installed.has(row.feature)) {
                features.set(row.feature, row.level);
            } else if (!this.warned.has(row.feature)) {
                this.warned.add(row.feature);
                logger.warn({ feature: row.feature }, 'maintenance : feature inconnue, ligne ignorée');
            }
        }
        return { site: site.active, message: site.message, features };
    }

    /**
     * Le nouvel état est posé avant tout effet : les gardes le voient aussitôt.
     * Les écrans sont prévenus avant l'arrêt des services, qui peut attendre la
     * fin d'un tour en cours : rendu à part (dans un objet, qu'une promesse ne
     * s'aplatisse pas), il ne retient pas la file d'état.
     */
    private async apply(next: Snapshot): Promise<{ settled: Promise<void> }> {
        const prev = this.current;
        if (sameSnapshot(prev, next)) return { settled: Promise.resolve() };
        const { db, live, logger, services } = this.need();
        this.current = next;
        logger.warn({ site: next.site, features: Object.fromEntries(next.features) }, 'maintenance : nouvel état');

        live.broadcast(MAINTENANCE_EVENT, this.clientState());
        if (!prev.site && next.site) {
            const admins = new Set(await db.users.listAdminIds());
            live.closeWhere((userId) => !admins.has(userId), MAINTENANCE_CLOSE_CODE, 'maintenance');
        }

        const settling: Promise<void>[] = [];
        for (const id of new Set([...prev.features.keys(), ...next.features.keys()])) {
            const wasFull = prev.features.get(id) === 'full';
            const isFull = next.features.get(id) === 'full';
            if (wasFull === isFull || !services.hasService(id)) continue;
            const run = (this.transitions.get(id) ?? Promise.resolve()).then(async () => {
                try {
                    await (isFull ? services.stop(id) : services.start(id));
                } catch (error) {
                    logger.error(
                        { err: error, feature: id },
                        isFull ? 'maintenance : arrêt en échec' : 'maintenance : relance en échec'
                    );
                }
            });
            this.transitions.set(id, run);
            settling.push(run);
        }
        return { settled: Promise.all(settling).then(() => undefined) };
    }
}

export const maintenance = new MaintenanceStore();

const escapeHtml = (value: string): string =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Le 503 d'une route publique : une page lisible pour un visiteur, l'enveloppe d'erreur pour un programme. */
export function replyMaintenance(req: FastifyRequest, reply: FastifyReply): FastifyReply {
    const message = maintenance.siteDown() ? maintenance.message() : FEATURE_MAINTENANCE_MESSAGE;
    reply.code(503).header('Retry-After', '300');
    if (!(req.headers.accept ?? '').includes('text/html')) return reply.send(err('maintenance', message));
    return reply
        .type('text/html; charset=utf-8')
        .send(
            `<!doctype html><html lang="fr"><head><meta charset="utf-8">` +
                `<meta name="viewport" content="width=device-width, initial-scale=1"><title>Maintenance</title></head>` +
                `<body style="margin:0;padding:16px;min-height:100vh;box-sizing:border-box;display:grid;place-items:center;font-family:system-ui,sans-serif;text-align:center">` +
                `<p style="max-width:32rem;white-space:pre-line;line-height:1.5">${escapeHtml(message)}</p></body></html>`
        );
}
