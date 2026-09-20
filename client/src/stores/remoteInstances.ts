import {
    loginResponseSchema,
    refreshResponseSchema,
    resultSchema,
    serverStatusSchema,
    wsTicketResponseSchema,
    type RemoteInstance,
    type SessionBundle,
    type SessionTokens,
    type User,
    type Workspace,
    type WorkspaceKind
} from '@deveye/types';
import { useEffect, useSyncExternalStore } from 'react';
import { z } from 'zod';

import { ApiError, requestAt, setHttpTargetResolver, type HttpTarget } from '@/api/http';
import { clearRemoteVault, deleteRemoteToken, readRemoteToken, writeRemoteToken } from '@/api/remoteVault';
import { ws, wsUrlOf, WsUnauthorizedError } from '@/api/ws';
import { getLocalUser, setActingUser } from './currentUser';
import { requestSelectWorkspace } from './viewRequest';
import { getActiveInstanceId, onWorkspaceChange, setRemoteWorkspaces } from './workspace';

/**
 * Les instances distantes du compte, vues du navigateur : sont-elles joignables,
 * y a-t-on une session, quels espaces y a-t-on vus.
 *
 * Tout ce qui parle à une instance distante part d'ici, et rien n'en revient
 * vers le serveur d'accueil : ni jeton, ni identifiant, ni donnée. La session
 * vit dans cet onglet ; « Retenir sur cet appareil » en garde le seul jeton de
 * rafraîchissement dans le navigateur (`api/remoteVault.ts`).
 */

/**
 * - `online` : répond, accepte notre page, même version que ce client.
 * - `closed` : répond, mais sa fédération est éteinte.
 * - `incompatible` : répond, à une autre version ; ce client parlerait un autre contrat.
 * - `offline` : ne répond pas, ou refuse notre origine (le navigateur ne dit pas lequel).
 */
export type RemoteReach = 'unknown' | 'online' | 'offline' | 'closed' | 'incompatible';

/** Un espace distant tel qu'on l'a vu la dernière fois : de quoi tenir sa rangée hors session. */
export interface KnownWorkspace {
    id: number;
    kind: WorkspaceKind;
    name: string;
    members: number;
}

export interface RemoteEntry {
    instance: RemoteInstance;
    reach: RemoteReach;
    /** Version annoncée par l'instance, quand elle répond. */
    version: string | null;
    /** Le compte ouvert là-bas, tant que sa session vit dans cet onglet. */
    user: User | null;
    known: readonly KnownWorkspace[];
}

interface Session {
    tokens: SessionTokens;
    /** Échéance du jeton d'accès, en ms. */
    expiresAt: number;
    remember: boolean;
    renewing: Promise<string> | null;
}

const KNOWN_PREFIX = 'deveye:remoteKnown';
const PING_TIMEOUT_MS = 3000;
const PING_INTERVAL_MS = 60_000;
/** Un jeton à moins de ça de sa fin est renouvelé avant de servir. */
const RENEW_MARGIN_MS = 30_000;

let entries: readonly RemoteEntry[] = [];
const sessions = new Map<number, Session>();
const listeners = new Set<() => void>();

function emit(): void {
    for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

const entryOf = (instanceId: number): RemoteEntry | undefined => entries.find((e) => e.instance.id === instanceId);

function patch(instanceId: number, change: Partial<Omit<RemoteEntry, 'instance'>>): void {
    entries = entries.map((e) => (e.instance.id === instanceId ? { ...e, ...change } : e));
    emit();
    if (instanceId === getActiveInstanceId()) setActingUser(entryOf(instanceId)?.user ?? null);
}

const knownSchema = z.array(
    z.object({ id: z.number(), kind: z.enum(['personal', 'shared']), name: z.string(), members: z.number() })
);

function readKnown(instanceId: number): KnownWorkspace[] {
    try {
        const parsed = knownSchema.safeParse(JSON.parse(localStorage.getItem(`${KNOWN_PREFIX}:${instanceId}`) ?? ''));
        return parsed.success ? parsed.data : [];
    } catch {
        return [];
    }
}

function writeKnown(instanceId: number, known: readonly KnownWorkspace[] | null): void {
    try {
        if (known === null) localStorage.removeItem(`${KNOWN_PREFIX}:${instanceId}`);
        else localStorage.setItem(`${KNOWN_PREFIX}:${instanceId}`, JSON.stringify(known));
    } catch {
        /* ignoré : la liste revient à la prochaine session */
    }
}

const toKnown = (workspaces: readonly Workspace[]): KnownWorkspace[] =>
    workspaces.map((w) => ({ id: w.id, kind: w.kind, name: w.name, members: w.users.length }));

/** Deux versions parlent le même contrat quand majeur et mineur coïncident. */
export function sameRelease(a: string, b: string): boolean {
    const release = (v: string): string => v.split('.').slice(0, 2).join('.');
    return release(a) === release(b);
}

// ------------------------------------------------------------------ lecture

export function getRemoteInstances(): readonly RemoteEntry[] {
    return entries;
}

export function useRemoteInstances(): readonly RemoteEntry[] {
    return useSyncExternalStore(subscribe, getRemoteInstances, getRemoteInstances);
}

export function hasRemoteSession(instanceId: number): boolean {
    return sessions.has(instanceId);
}

/** Peut-on y envoyer quelque chose maintenant : une session, et une instance qui répond. */
export function isRemoteUsable(entry: RemoteEntry): boolean {
    return entry.user !== null && entry.reach !== 'offline' && entry.reach !== 'incompatible';
}

// ------------------------------------------------------------------ la liste

/** Ce que la session d'ici vient de livrer : la liste fait foi, une instance retirée perd sa session. */
export function syncRemoteInstances(instances: readonly RemoteInstance[]): void {
    const kept = new Set(instances.map((i) => i.id));
    for (const gone of entries.filter((e) => !kept.has(e.instance.id))) {
        dropSession(gone.instance.id);
        writeKnown(gone.instance.id, null);
    }
    entries = instances.map((instance) => {
        const existing = entryOf(instance.id);
        return existing
            ? { ...existing, instance }
            : { instance, reach: 'unknown', version: null, user: null, known: readKnown(instance.id) };
    });
    emit();
}

// ------------------------------------------------------------------ la sonde

export async function pingRemote(instanceId: number): Promise<RemoteReach> {
    const entry = entryOf(instanceId);
    if (!entry) return 'offline';
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), PING_TIMEOUT_MS);
    let reach: RemoteReach = 'offline';
    let version: string | null = null;
    try {
        // Un `GET` nu : ni en-tête ni identifiant, donc aucun prévol CORS.
        const res = await fetch(`${entry.instance.origin}/api/status`, { credentials: 'omit', signal: abort.signal });
        const parsed = resultSchema(serverStatusSchema).safeParse(await res.json());
        if (parsed.success && parsed.data.ok) {
            version = parsed.data.data.version;
            if (!parsed.data.data.federation) reach = 'closed';
            else reach = sameRelease(version, __APP_VERSION__) ? 'online' : 'incompatible';
        }
    } catch {
        reach = 'offline';
    } finally {
        clearTimeout(timer);
    }
    patch(instanceId, { reach, version });
    return reach;
}

export function pingAllRemotes(): void {
    for (const e of entries) void pingRemote(e.instance.id);
}

/** Sonde tant que `active`, onglet visible : à l'ouverture, puis chaque minute. */
export function useRemotePing(active: boolean): void {
    const count = useRemoteInstances().length;
    useEffect(() => {
        if (!active || count === 0) return;
        const tick = (): void => {
            if (document.visibilityState === 'visible') pingAllRemotes();
        };
        tick();
        const timer = setInterval(tick, PING_INTERVAL_MS);
        return () => clearInterval(timer);
    }, [active, count]);
}

// ------------------------------------------------------------------ la session

const anonymous = (instanceId: number): { origin: string; anonymous: true } => {
    const entry = entryOf(instanceId);
    if (!entry) throw new ApiError('not_found', 'Instance distante inconnue');
    return { origin: entry.instance.origin, anonymous: true };
};

const NOT_FEDERATED = 'Cette instance n’autorise pas cette adresse à s’y connecter (FEDERATION_ORIGINS).';

function adopt(instanceId: number, tokens: SessionTokens): void {
    const session = sessions.get(instanceId);
    if (!session) return;
    session.tokens = tokens;
    session.expiresAt = Date.now() + tokens.accessTtlSeconds * 1000;
    const me = getLocalUser();
    if (session.remember && me) void writeRemoteToken(me.id, instanceId, tokens.refresh);
}

/** Ce qu'une réponse de session dit du compte et de ses espaces là-bas. */
function applyBundle(instanceId: number, bundle: SessionBundle): void {
    const known = toKnown(bundle.workspaces);
    writeKnown(instanceId, known);
    setRemoteWorkspaces(instanceId, bundle.workspaces);
    patch(instanceId, { user: bundle.user, known, reach: 'online' });
}

/**
 * Renouvelle la session, un seul appel en vol. Entre onglets, la rotation du
 * jeton de rafraîchissement se sérialise : deux onglets qui retiennent la même
 * session se passeraient sinon un jeton déjà tourné, que l'instance prend pour
 * un vol et sanctionne en révoquant la session entière.
 */
function renew(instanceId: number): Promise<string> {
    const session = sessions.get(instanceId);
    if (!session) return Promise.reject(new ApiError('auth_required', 'Aucune session sur cette instance'));
    session.renewing ??= (async () => {
        const rotate = async (): Promise<string> => {
            const me = getLocalUser();
            const stored = session.remember && me ? await readRemoteToken(me.id, instanceId) : null;
            const res = await requestAt(
                anonymous(instanceId),
                '/api/auth/refresh',
                { method: 'POST', body: JSON.stringify({ refreshToken: stored ?? session.tokens.refresh }) },
                refreshResponseSchema
            );
            if (!res.tokens) throw new ApiError('forbidden', NOT_FEDERATED);
            adopt(instanceId, res.tokens);
            applyBundle(instanceId, res);
            return res.tokens.access;
        };
        try {
            return session.remember && 'locks' in navigator
                ? await navigator.locks.request(`deveye-remote-${instanceId}`, rotate)
                : await rotate();
        } finally {
            session.renewing = null;
        }
    })();
    return session.renewing;
}

/** Relit le compte et les espaces de là-bas (un membre arrivé, un espace renommé). */
export function refreshRemoteSession(instanceId: number): Promise<void> {
    return renew(instanceId).then(() => undefined);
}

/** Le compte de là-bas a changé sous nos doigts (avatar, nom) : l'écran le montre sans attendre. */
export function patchRemoteUser(instanceId: number, change: Partial<User>): void {
    const user = entryOf(instanceId)?.user;
    if (user) patch(instanceId, { user: { ...user, ...change } });
}

function targetOf(instanceId: number): HttpTarget {
    const entry = entryOf(instanceId);
    const session = sessions.get(instanceId);
    if (!entry || !session) throw new ApiError('auth_required', 'Instance distante déconnectée');
    return {
        origin: entry.instance.origin,
        fresh: () =>
            session.expiresAt - Date.now() > RENEW_MARGIN_MS
                ? Promise.resolve(session.tokens.access)
                : renew(instanceId),
        renew: () => renew(instanceId),
        adopt: (tokens) => adopt(instanceId, tokens)
    };
}
setHttpTargetResolver(targetOf);

const isDeadSession = (e: unknown): boolean =>
    e instanceof ApiError && ['auth_required', 'auth_expired', 'auth_invalid', 'forbidden'].includes(e.code);

/** Ouvre la socket de l'instance. Un ticket frais à chaque (re)connexion : il ne sert qu'une fois. */
async function attach(instanceId: number): Promise<void> {
    const entry = entryOf(instanceId);
    if (!entry) return;
    const conn = ws.attachRemote({
        instanceId,
        url: async () => {
            try {
                const { ticket } = await requestAt(
                    targetOf(instanceId),
                    '/api/auth/ws-ticket',
                    { method: 'POST' },
                    wsTicketResponseSchema
                );
                return wsUrlOf(entry.instance.origin, ticket);
            } catch (e) {
                if (isDeadSession(e)) throw new WsUnauthorizedError();
                throw e;
            }
        }
    });
    conn.onUnauthorized(() => dropSession(instanceId));
    await conn.connect().catch(() => {});
}

async function openSession(
    instanceId: number,
    bundle: SessionBundle,
    tokens: SessionTokens,
    remember: boolean
): Promise<void> {
    sessions.set(instanceId, { tokens, expiresAt: 0, remember, renewing: null });
    adopt(instanceId, tokens);
    applyBundle(instanceId, bundle);
    await attach(instanceId);
}

/**
 * Oublie la session d'une instance, sans rien lui demander : elle est morte, ou
 * l'instance n'est plus dans la liste. Assis là-bas, on rentre chez soi.
 */
function dropSession(instanceId: number): void {
    if (!sessions.delete(instanceId)) return;
    ws.detachRemote(instanceId);
    const me = getLocalUser();
    if (me) void deleteRemoteToken(me.id, instanceId);
    const wasActive = getActiveInstanceId() === instanceId;
    if (wasActive && me) requestSelectWorkspace(me.personalWorkspaceId, null);
    setRemoteWorkspaces(instanceId, null);
    patch(instanceId, { user: null });
}

export type RemoteLoginStep = { twoFactorRequired: true; challenge: string } | { twoFactorRequired: false };

export async function loginRemote(
    instanceId: number,
    credentials: { username: string; password: string },
    remember: boolean
): Promise<RemoteLoginStep> {
    const res = await requestAt(
        anonymous(instanceId),
        '/api/auth/login',
        { method: 'POST', body: JSON.stringify(credentials) },
        loginResponseSchema
    );
    if (res.twoFactorRequired) {
        if (!res.challenge) throw new ApiError('forbidden', NOT_FEDERATED);
        return { twoFactorRequired: true, challenge: res.challenge };
    }
    if (!res.tokens) throw new ApiError('forbidden', NOT_FEDERATED);
    await openSession(instanceId, res, res.tokens, remember);
    return { twoFactorRequired: false };
}

export async function submitRemoteTwoFactor(
    instanceId: number,
    step: { code: string; challenge: string },
    remember: boolean
): Promise<void> {
    const res = await requestAt(
        anonymous(instanceId),
        '/api/auth/2fa/challenge',
        { method: 'POST', body: JSON.stringify(step) },
        loginResponseSchema
    );
    if (res.twoFactorRequired || !res.tokens) throw new ApiError('forbidden', NOT_FEDERATED);
    await openSession(instanceId, res, res.tokens, remember);
}

export function cancelRemoteTwoFactor(instanceId: number, challenge: string): void {
    void requestAt(
        anonymous(instanceId),
        '/api/auth/2fa/cancel',
        { method: 'POST', body: JSON.stringify({ challenge }) },
        z.unknown()
    ).catch(() => {});
}

/** La session est-elle prête à servir : socket ouverte comprise. Sert juste avant d'y basculer. */
export async function ensureRemoteReady(instanceId: number): Promise<boolean> {
    if (!sessions.has(instanceId)) return false;
    const conn = ws.connectionFor(instanceId);
    if (!conn) return false;
    if (conn.state !== 'open') await conn.reconnect().catch(() => {});
    return conn.state === 'open';
}

/** Reprend les sessions retenues sur cet appareil. Une instance injoignable garde son jeton pour plus tard. */
export async function restoreRemoteSessions(): Promise<void> {
    const me = getLocalUser();
    if (!me) return;
    await Promise.all(
        entries.map(async ({ instance }) => {
            if (sessions.has(instance.id)) return;
            const refresh = await readRemoteToken(me.id, instance.id);
            if (!refresh) return;
            sessions.set(instance.id, {
                tokens: { access: '', refresh, accessTtlSeconds: 1 },
                expiresAt: 0,
                remember: true,
                renewing: null
            });
            try {
                await renew(instance.id);
                await attach(instance.id);
            } catch (e) {
                sessions.delete(instance.id);
                if (isDeadSession(e)) void deleteRemoteToken(me.id, instance.id);
            }
        })
    );
}

/** Déconnexion voulue d'une instance : sa session y est révoquée, au mieux. */
export async function logoutRemote(instanceId: number): Promise<void> {
    const session = sessions.get(instanceId);
    if (!session) return;
    await requestAt(
        anonymous(instanceId),
        '/api/auth/logout',
        { method: 'POST', body: JSON.stringify({ refreshToken: session.tokens.refresh }) },
        z.unknown()
    ).catch(() => {});
    dropSession(instanceId);
}

/**
 * Déconnexion d'ici : rien des instances distantes ne survit sur ce poste. Les
 * révocations partent sans être attendues, une instance injoignable ne doit pas
 * retenir la déconnexion.
 */
export function forgetRemoteSessions(): void {
    for (const instanceId of [...sessions.keys()]) void logoutRemote(instanceId);
    void clearRemoteVault();
    entries = [];
    emit();
}

// ------------------------------------------------------------------ branchements

onWorkspaceChange(() => {
    const instanceId = getActiveInstanceId();
    setActingUser(instanceId === null ? null : (entryOf(instanceId)?.user ?? null));
});

/**
 * La politique de contenu du document est figée à son chargement. Une instance
 * déclarée depuis un autre appareil n'y figure pas encore : la première requête
 * bloquée vers elle vaut un rechargement, une seule fois par adresse.
 */
if (typeof document !== 'undefined') {
    document.addEventListener('securitypolicyviolation', (e) => {
        if (e.effectiveDirective !== 'connect-src') return;
        let origin: string;
        try {
            origin = new URL(e.blockedURI.replace(/^ws/, 'http')).origin;
        } catch {
            return;
        }
        if (!entries.some((entry) => entry.instance.origin === origin)) return;
        try {
            const flag = `deveye.cspReload:${origin}`;
            if (sessionStorage.getItem(flag)) return;
            sessionStorage.setItem(flag, '1');
            window.location.reload();
        } catch {
            /* sans stockage de session, pas de garde contre la boucle : on s'abstient */
        }
    });
}
