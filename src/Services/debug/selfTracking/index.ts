import type { FastifyRequest } from 'fastify';
import type { DebugTracking, DebugTrackingCompanion } from '@deveye/types';
import {
    AUDIENCE_SELF_PROVIDER,
    type AudienceSelfEvent,
    type AudienceSelfFormField,
    type AudienceSelfProvider
} from '@deveye/types/sdk';

import { ACCESS_COOKIE } from '@/auth/cookies';
import { verifyAccessToken } from '@/auth/jwt';
import type { Database } from '@/db';
import { FeatureError } from '@/features/_define';
import { ORIGINS } from '@/features/_sdk/context';
import { moduleProvider } from '@/features/_sdk/register';
import type { StatusTracking } from '@/Services/statusProbeContract';
import { env } from '@/Utils/Env';
import { runGate } from '../e2e/gate';
import { isTestEmail } from '../e2e/identity';
import {
    clearTracking,
    otherTrackings,
    readTracking,
    writeTracking,
    type StoredTracking,
    type TrackingCompanionKind,
    type TrackingConfig
} from './config';
import { authEvent, commandEvent, excluded, failureEvent, isStaticPath } from './events';

/** Une même action d'une même connexion ne compte qu'une fois par fenêtre : un texte enregistré à la frappe n'est pas cent actions. */
const THROTTLE_MS = 10_000;

/** Ce que le site de chaque page publique dit de lui-même dans Audience. */
const COMPANIONS: Record<TrackingCompanionKind, { label: string; description: string }> = {
    status: {
        label: 'Page d’état',
        description: 'La page d’état publique de cette instance de DevEye, mesurée par sa balise.'
    },
    site: {
        label: 'Site',
        description:
            'Le site vitrine de cette instance de DevEye, mesuré par sa balise. Sa fenêtre « Écris-moi » arrive dans le formulaire « contact ».'
    }
};

/**
 * Le formulaire de contact du site vitrine, tel que sa fenêtre l'envoie. Le
 * sujet est un texte et non un choix fermé : ses libellés vivent dans le site,
 * et un choix déclaré ici qui ne les reprendrait pas au mot près refuserait
 * tout message.
 */
const SITE_CONTACT_FORM: { name: string; fields: readonly AudienceSelfFormField[] } = {
    name: 'contact',
    fields: [
        { name: 'subject', kind: 'text', required: true },
        { name: 'name', kind: 'text', required: true },
        { name: 'email', kind: 'email', required: true },
        { name: 'message', kind: 'text', required: true }
    ]
};

/** Les pages publiques qui ont une adresse, dans l'ordre où l'écran les montre. */
function companionTargets(): { kind: TrackingCompanionKind; url: string }[] {
    const out: { kind: TrackingCompanionKind; url: string }[] = [];
    if (env.STATUS_PAGE_URL) out.push({ kind: 'status', url: env.STATUS_PAGE_URL.replace(/\/+$/, '') });
    if (ORIGINS.site) out.push({ kind: 'site', url: ORIGINS.site });
    return out;
}

interface Visitor {
    ip: string;
    userAgent: string;
    fromRun: boolean;
}

interface Account {
    role: string;
    e2eRun: string | null;
}

export interface ViewInput {
    path: string;
    at?: number;
    referrer?: string;
    language?: string;
    timezone?: string;
    tzOffset?: number;
    screenWidth?: number;
}

type TrackedRequest = Pick<FastifyRequest, 'ip' | 'headers' | 'raw' | 'cookies'>;

let db: Database | null = null;
let stored: StoredTracking | null = null;
/** Change à chaque relecture du réglage : une connexion refait alors son verdict d'exclusion. */
let generation = 0;
const counters = { sent: 0, excluded: 0 };

const provider = (): AudienceSelfProvider | undefined => moduleProvider<AudienceSelfProvider>(AUDIENCE_SELF_PROVIDER);

const active = (): boolean => Boolean(stored?.config.enabled && provider());

function visitorOf(req: Pick<FastifyRequest, 'ip' | 'headers' | 'raw'>): Visitor {
    const ua = req.headers['user-agent'];
    return { ip: req.ip, userAgent: typeof ua === 'string' ? ua : '', fromRun: runGate.allows(req.raw) };
}

async function accountOf(userId: number): Promise<Account | null> {
    const row = await db?.users.findById(userId);
    return row ? { role: row.role, e2eRun: row.e2e_run } : null;
}

async function accountFromCookie(req: TrackedRequest): Promise<Account | null> {
    const claims = await verifyAccessToken(req.cookies?.[ACCESS_COOKIE] ?? '');
    return claims ? accountOf(Number(claims.sub)) : null;
}

function emit(visitor: Visitor, events: AudienceSelfEvent[]): void {
    const target = provider();
    if (!stored || !target || events.length === 0) return;
    target.ingest({ key: stored.config.key, ip: visitor.ip, userAgent: visitor.userAgent, events });
    counters.sent += events.length;
}

function isExcluded(account: Account | null, visitor: Visitor): boolean {
    return !stored || excluded(account, stored.config, visitor.fromRun);
}

const codeOf = (error: unknown): string => {
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === 'string' ? code : 'internal';
};

async function reload(): Promise<void> {
    stored = db ? await readTracking(db, ORIGINS.app) : null;
    generation++;
}

/** Un site du même nom, laissé par un branchement précédent, ne bloque pas la création : le suivant est numéroté. */
async function createNamed(
    target: AudienceSelfProvider,
    workspaceId: number,
    name: string,
    input: Omit<Parameters<AudienceSelfProvider['createSite']>[1], 'name'>
): Promise<Awaited<ReturnType<AudienceSelfProvider['createSite']>>> {
    for (let n = 1; ; n++) {
        try {
            return await target.createSite(workspaceId, { ...input, name: n === 1 ? name : `${name} (${n})` });
        } catch (e) {
            if (codeOf(e) !== 'validation' || n === 5) throw e;
        }
    }
}

/**
 * Le suivi d'usage de DevEye dans un site Audience de cette instance : les
 * pages que les membres ouvrent, les actions qu'ils font, les refus qu'ils
 * rencontrent. Anonyme, comme tout site suivi : un visiteur ne se reconnaît
 * pas d'un jour à l'autre. Le réglage vaut pour ce serveur seul (son
 * `PUBLIC_ORIGIN`) : un serveur de dev sur la base de la prod n'y écrit rien.
 */
export const selfTracking = {
    async init(database: Database): Promise<void> {
        db = database;
        await reload();
    },

    /** Le suivi d'une socket : toutes ses commandes passent par le dispatcheur, qui le prévient. */
    forConnection(req: Pick<FastifyRequest, 'ip' | 'headers' | 'raw'>, userId: number) {
        const visitor = visitorOf(req);
        let verdict: { generation: number; excluded: Promise<boolean> } | null = null;
        const last = new Map<string, number>();
        const send = (event: AudienceSelfEvent): void => {
            if (!active()) return;
            const now = Date.now();
            const key = event.name ?? event.path;
            if (now - (last.get(key) ?? 0) < THROTTLE_MS) return;
            last.set(key, now);
            if (verdict?.generation !== generation) {
                verdict = { generation, excluded: accountOf(userId).then((a) => isExcluded(a, visitor)) };
            }
            void verdict.excluded
                .then((out) => {
                    if (out) counters.excluded++;
                    else emit(visitor, [event]);
                })
                .catch(() => undefined);
        };
        return {
            wrote: (command: string): void => send(commandEvent(command)),
            failed: (command: string, error: unknown): void => send(failureEvent(command, codeOf(error)))
        };
    },

    /** Les pages que le navigateur a ouvertes, connecté ou non. */
    async views(req: TrackedRequest, views: readonly ViewInput[]): Promise<void> {
        if (!active()) return;
        const visitor = visitorOf(req);
        if (isExcluded(await accountFromCookie(req), visitor)) {
            counters.excluded += views.length;
            return;
        }
        emit(
            visitor,
            views.filter((v) => isStaticPath(v.path)).map((v) => ({ type: 'view' as const, ...v }))
        );
    },

    /** Une route d'authentification vient de répondre. */
    async auth(
        req: TrackedRequest & Pick<FastifyRequest, 'routeOptions' | 'url' | 'body'>,
        status: number
    ): Promise<void> {
        if (!active()) return;
        const event = authEvent(req.routeOptions.url ?? req.url.split('?')[0], status);
        if (!event) return;
        const visitor = visitorOf(req);
        const body = (req.body ?? {}) as { username?: unknown; email?: unknown };
        let account = await accountFromCookie(req);
        if (!account && typeof body.username === 'string') {
            const row = await db?.users.findByUsername(body.username);
            account = row ? { role: row.role, e2eRun: row.e2e_run } : null;
        }
        if ((typeof body.email === 'string' && isTestEmail(body.email)) || isExcluded(account, visitor)) {
            counters.excluded++;
            return;
        }
        emit(visitor, [event]);
    },

    /** Pour le navigateur : le suivi est-il actif, et l'écarte-t-il (un administrateur) ? */
    async stateFor(req: TrackedRequest): Promise<{ active: boolean; excluded: boolean }> {
        if (!active()) return { active: false, excluded: false };
        return { active: true, excluded: isExcluded(await accountFromCookie(req), visitorOf(req)) };
    },

    async describe(): Promise<DebugTracking> {
        const target = provider();
        const others = db ? await otherTrackings(db, ORIGINS.app) : [];
        const companions: DebugTrackingCompanion[] = await Promise.all(
            companionTargets().map(async ({ kind, url }) => {
                const held = stored?.config[kind];
                if (!held) return { kind, url, site: null };
                const site = target ? await target.findByKey(held.key) : null;
                return { kind, url, site: { siteId: held.siteId, siteName: site?.name ?? null, key: held.key } };
            })
        );
        const base = {
            origin: ORIGINS.app,
            ingestOrigin: ORIGINS.public,
            audienceInstalled: Boolean(target),
            companions,
            others,
            counters: { ...counters }
        };
        if (!stored) return { ...base, config: null };
        const { config, updated, updatedBy } = stored;
        const site = target ? await target.findByKey(config.key) : null;
        return {
            ...base,
            config: {
                siteId: config.siteId,
                siteName: site?.name ?? null,
                workspaceId: config.workspaceId,
                keyHint: `…${config.key.slice(-4)}`,
                enabled: config.enabled,
                excludeAdmins: config.excludeAdmins,
                updated,
                updatedBy
            }
        };
    },

    /**
     * Crée ce qui manque : le site de l'app dans l'espace personnel de
     * l'administrateur s'il n'est pas branché, puis celui de chaque page
     * publique qui n'en a pas encore, dans le même espace. Le réglage est
     * écrit après chaque site, pour qu'un refus sur le suivant (la limite de
     * l'offre) ne laisse pas un site créé que rien ne désigne.
     */
    async create(admin: { id: number; workspaceId: number }): Promise<void> {
        const target = provider();
        if (!db || !target) throw new FeatureError('conflict', 'Le module Audience n’est pas installé');
        const missing = companionTargets().filter(({ kind }) => !stored?.config[kind]);
        if (stored && missing.length === 0) {
            throw new FeatureError('conflict', 'Tout est déjà déclaré : l’app et chacune de ses pages publiques.');
        }
        let config: TrackingConfig;
        if (stored) {
            config = stored.config;
        } else {
            const host = new URL(ORIGINS.app).host;
            const site = await createNamed(target, admin.workspaceId, `DevEye : ${host}`, {
                host,
                description: 'L’usage de cette instance de DevEye, relevé par le serveur lui-même.',
                measuredBy: 'server'
            });
            config = {
                key: site.publicKey,
                siteId: site.siteId,
                workspaceId: site.workspaceId,
                enabled: true,
                excludeAdmins: true
            };
            await writeTracking(db, ORIGINS.app, config, admin.id);
        }
        for (const { kind, url } of missing) {
            const host = new URL(url).host;
            const site = await createNamed(target, config.workspaceId, `${COMPANIONS[kind].label} : ${host}`, {
                host,
                description: COMPANIONS[kind].description,
                measuredBy: 'beacon'
            });
            if (kind === 'site') await target.declareForm(site.workspaceId, site.siteId, SITE_CONTACT_FORM);
            config = { ...config, [kind]: { key: site.publicKey, siteId: site.siteId } };
            await writeTracking(db, ORIGINS.app, config, admin.id);
        }
        await reload();
    },

    /** Se branche sur un site existant ; il doit vivre dans un espace de l'administrateur, sans quoi l'usage de DevEye irait à un tiers. */
    async use(adminId: number, key: string): Promise<void> {
        const target = provider();
        if (!db || !target) throw new FeatureError('conflict', 'Le module Audience n’est pas installé');
        const site = await target.findByKey(key);
        if (!site) throw new FeatureError('not_found', 'Aucun site Audience ne porte cette clé');
        const workspace = await db.workspaces.findById(site.workspaceId);
        if (workspace?.owner_user_id !== adminId) {
            throw new FeatureError('forbidden', 'Ce site n’appartient à aucun de vos espaces');
        }
        await writeTracking(
            db,
            ORIGINS.app,
            {
                ...stored?.config,
                key,
                siteId: site.siteId,
                workspaceId: site.workspaceId,
                enabled: true,
                excludeAdmins: stored?.config.excludeAdmins ?? true
            },
            adminId
        );
        await reload();
    },

    /** La balise de la page d'état, qu'elle vient lire ici : sa clé et l'origine qui sert le script. */
    statusTracking(): StatusTracking {
        const held = stored?.config.status;
        if (!held || !active()) return null;
        return { key: held.key, origin: ORIGINS.public };
    },

    async set(adminId: number, patch: { enabled: boolean; excludeAdmins: boolean }): Promise<void> {
        if (!db || !stored) throw new FeatureError('conflict', 'Ce serveur n’est branché sur aucun site');
        await writeTracking(db, ORIGINS.app, { ...stored.config, ...patch }, adminId);
        await reload();
    },

    async clear(): Promise<void> {
        if (!db) return;
        await clearTracking(db, ORIGINS.app);
        await reload();
    }
};
