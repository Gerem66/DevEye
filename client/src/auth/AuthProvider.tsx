import type { SessionBundle, User } from '@deveye/types';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError, login as apiLogin, logout as apiLogout, me as apiMe, refresh as apiRefresh } from '../api/http';
import { startActivityBeacon } from '../api/activity';
import { ws } from '../api/ws';
import { setAdmission } from '../stores/admission';
import { setUnlocked } from '../stores/secrecy';
import { resetHomeReady } from '../stores/homeReady';
import { resetTheme, syncThemeFromServer } from '../stores/theme';
import { resetHomeLayout, syncHomeLayoutFromServer } from '../stores/homeLayout';
import { resetWorkspace, syncWorkspacesFromServer } from '../stores/workspace';
import { resetLive } from '../stores/live';
import { setCurrentUser, useActingUser } from '../stores/currentUser';
import { forgetRemoteSessions, patchRemoteUser, syncRemoteInstances } from '../stores/remoteInstances';
import { getActiveInstanceId } from '../stores/workspace';
import { setFeedbackEnabled } from '../stores/feedbackEnabled';
import { setSiteUrl } from '../stores/siteUrl';
import { setMaintenanceEnvNotice, setPublicMaintenance } from '../stores/maintenance';
import { devicesProvider } from '../devicesProvider';

interface AuthState {
    status: 'unknown' | 'authenticated' | 'anonymous';
    user: User | null;
}

export interface LoginResult {
    twoFactorRequired: boolean;
}

interface AuthContextValue extends AuthState {
    /** Le serveur ne répond plus depuis plusieurs tentatives : l'écran d'attente le dit. */
    unreachable: boolean;
    login: (username: string, password: string) => Promise<LoginResult>;
    logout: () => Promise<void>;
    refresh: () => Promise<void>;
    updateUser: (patch: Partial<User>) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Le premier délai de reprise, puis doublement jusqu'au plafond. */
const RETRY_BASE_MS = 300;
const RETRY_MAX_MS = 10000;
/** Passé ce temps d'attente, l'écran de démarrage le dit : un redémarrage de serveur tient dessous. */
const UNREACHABLE_AFTER_MS = 8000;

/**
 * Vrai quand l'échec dit « le serveur est injoignable », pas « tu n'es pas
 * connecté » : coupure réseau, 5xx, ou réponse illisible (le proxy de dev répond
 * un 500 au corps vide pendant que le serveur redémarre). Les cookies de session
 * restent valides : déconnecter serait un contresens, il faut réessayer.
 */
function isTransportFailure(e: unknown): boolean {
    return e instanceof ApiError && (e.code === 'network' || e.code === 'unknown' || (e.status ?? 0) >= 500);
}

/**
 * Le site est en maintenance et ce compte n'y entre pas : la page de maintenance
 * prend l'écran (`App.tsx`), la session reste telle quelle pour la reprise.
 */
function isMaintenanceRefusal(e: unknown): boolean {
    if (!(e instanceof ApiError) || e.code !== 'maintenance') return false;
    setPublicMaintenance({ site: true, message: e.message });
    return true;
}

/**
 * Applique un bundle de session. L'ordre compte : l'espace actif est publie avant
 * le theme et la disposition, ces deux stores resolvant leur cle de stockage a
 * partir de lui.
 */
function applyBundle(bundle: SessionBundle): AuthState {
    // Publié ici et non au seul effet plus bas : l'accueil monte dans le même
    // rendu et ses effets passent avant ceux de ce fournisseur.
    setCurrentUser(bundle.user);
    syncRemoteInstances(bundle.remoteInstances);
    syncWorkspacesFromServer(bundle.workspaces, bundle.activeWorkspaceId, bundle.permissions);
    // Assis dans un espace distant, l'apparence et l'accueil affichés sont les
    // siens : ceux que cette session-ci décrit appartiennent à un espace d'ici.
    if (getActiveInstanceId() === null) {
        syncThemeFromServer(bundle.theme);
        syncHomeLayoutFromServer(bundle.homeLayout);
    }
    setFeedbackEnabled(bundle.feedbackEnabled);
    setSiteUrl(bundle.siteUrl);
    setMaintenanceEnvNotice(bundle.maintenanceEnvNotice);
    return { status: 'authenticated', user: bundle.user };
}

/**
 * Ce que la session a laissé dans le navigateur : l'accueil (tuiles, adresses des
 * raccourcis, noms de dossiers) et le fond d'écran de chaque espace. Sur un poste
 * partagé, le compte suivant ne doit pas les trouver. Le mode de rendu reste : il
 * décrit la machine, pas le compte.
 */
function clearLocalTraces(): void {
    try {
        for (const key of Object.keys(localStorage)) {
            if (/^deveye[:.]/.test(key) && key !== 'deveye:render') localStorage.removeItem(key);
        }
    } catch {
        // Stockage indisponible (navigation privée stricte) : rien à effacer.
    }
}

export function AuthProvider({ children }: { children: ReactNode }) {
    const [state, setState] = useState<AuthState>({ status: 'unknown', user: null });
    const [unreachable, setUnreachable] = useState(false);
    // Le magasin `currentUser` suit l'état : c'est par lui que le barrel des modules
    // connaît l'utilisateur sans importer ce fournisseur.
    useEffect(() => {
        setCurrentUser(state.user);
    }, [state.user]);
    const refreshing = useRef<Promise<void> | null>(null);
    const reauthLock = useRef(false);
    // La reprise après indisponibilité : un seul essai en vol, le délai doublant
    // jusqu'au plafond. `refreshRef` évite la boucle de dépendances entre la
    // planification et la tentative qu'elle relance.
    const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const retryAttempt = useRef(0);
    const unreachableTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const refreshRef = useRef<() => Promise<void>>(() => Promise.resolve());

    const cancelRetry = useCallback(() => {
        if (retryTimer.current !== null) clearTimeout(retryTimer.current);
        if (unreachableTimer.current !== null) clearTimeout(unreachableTimer.current);
        retryTimer.current = null;
        unreachableTimer.current = null;
        retryAttempt.current = 0;
        setUnreachable(false);
    }, []);

    const scheduleRetry = useCallback(() => {
        if (retryTimer.current !== null) return;
        const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** retryAttempt.current);
        retryAttempt.current += 1;
        unreachableTimer.current ??= setTimeout(() => setUnreachable(true), UNREACHABLE_AFTER_MS);
        retryTimer.current = setTimeout(() => {
            retryTimer.current = null;
            void refreshRef.current();
        }, delay);
    }, []);

    const setAnonymous = useCallback(() => {
        cancelRetry();
        setUnlocked(false);
        // The next sign-in must wait for the home's first data again rather than
        // inherit this session's "ready" flag.
        resetHomeReady();
        // Sans ces trois remises a zero, se reconnecter avec un autre compte sur la
        // meme machine heriterait de l'espace, du theme et de l'accueil du precedent,
        // et estampillerait ses commandes avec un espace interdit.
        resetWorkspace();
        // Après `resetWorkspace` : plus personne n'est assis sur une instance
        // distante, fermer sa session ne déclenche donc aucune bascule.
        forgetRemoteSessions();
        resetTheme();
        resetHomeLayout();
        // La liste d'appareils est celle du module Appareils, quand il est là.
        devicesProvider()?.resetDevices();
        // Idem pour la presence, sans quoi la session suivante repartirait avec le
        // roster et le lieu declare de la precedente.
        resetLive();
        setAdmission(null);
        clearLocalTraces();
        setState({ status: 'anonymous', user: null });
    }, [cancelRetry]);

    /**
     * Refusé au démarrage : le formulaire de connexion doit pouvoir servir à un
     * administrateur, sans rien effacer d'une session qui reprendra à la levée.
     */
    const holdForMaintenance = useCallback(() => {
        cancelRetry();
        setState((prev) => (prev.status === 'unknown' ? { status: 'anonymous', user: null } : prev));
    }, [cancelRetry]);

    /** La session est ouverte : publier le bundle, rouvrir la socket (le store du coffre se relit à l'ouverture). */
    const startSession = useCallback(
        async (bundle: SessionBundle) => {
            cancelRetry();
            setState(applyBundle(bundle));
            await ws.connect().catch(() => {});
        },
        [cancelRetry]
    );

    const refresh = useCallback(async () => {
        if (refreshing.current) return refreshing.current;
        const task = (async () => {
            try {
                await startSession(await apiMe());
            } catch (e) {
                // Avant `isTransportFailure`, qui prendrait ce 503 pour une panne.
                if (isMaintenanceRefusal(e)) return holdForMaintenance();
                if (e instanceof ApiError && (e.code === 'auth_required' || e.code === 'auth_expired')) {
                    try {
                        await apiRefresh();
                        await startSession(await apiMe());
                    } catch (renewal) {
                        if (isMaintenanceRefusal(renewal)) holdForMaintenance();
                        else if (isTransportFailure(renewal)) scheduleRetry();
                        else setAnonymous();
                    }
                    return;
                }
                if (isTransportFailure(e)) scheduleRetry();
                else setAnonymous();
            }
        })();
        refreshing.current = task;
        try {
            await task;
        } finally {
            refreshing.current = null;
        }
    }, [setAnonymous, scheduleRetry, startSession, holdForMaintenance]);

    const login = useCallback(
        async (username: string, password: string): Promise<LoginResult> => {
            const bundle = await apiLogin({ username, password }).catch((e: unknown) => {
                // Le message du refus s'affiche sous le formulaire, comme les autres.
                isMaintenanceRefusal(e);
                throw e;
            });
            if (bundle.twoFactorRequired) {
                return { twoFactorRequired: true };
            }
            await startSession(bundle);
            return { twoFactorRequired: false };
        },
        [startSession]
    );

    const logout = useCallback(async () => {
        try {
            await apiLogout();
        } finally {
            ws.close();
            setAnonymous();
        }
    }, [setAnonymous]);

    const updateUser = useCallback((patch: Partial<User>) => {
        // Le compte qu'on modifie est celui qu'on EST : sur une instance
        // distante, celui de là-bas.
        const instanceId = getActiveInstanceId();
        if (instanceId !== null) {
            patchRemoteUser(instanceId, patch);
            return;
        }
        setState((prev) => (prev.user ? { ...prev, user: { ...prev.user, ...patch } } : prev));
    }, []);

    // A WS `4401` only means the access token expired, typically while the tab sat
    // in the background, and the refresh cookie is usually still valid: refresh the
    // session silently rather than drop the user to the login screen. Only a failed
    // refresh falls back to anonymous. The lock keeps a socket that is rejected again
    // right after a refresh from spinning in a refresh/reconnect loop.
    const reauthenticate = useCallback(async () => {
        if (reauthLock.current) return;
        reauthLock.current = true;
        try {
            await apiRefresh();
            await startSession(await apiMe());
        } catch (e) {
            if (isMaintenanceRefusal(e)) return;
            if (isTransportFailure(e)) scheduleRetry();
            else setAnonymous();
        } finally {
            setTimeout(() => {
                reauthLock.current = false;
            }, 3000);
        }
    }, [setAnonymous, scheduleRetry, startSession]);

    useEffect(() => {
        refreshRef.current = refresh;
    }, [refresh]);

    useEffect(() => {
        void refresh();
        return cancelRetry;
    }, [refresh, cancelRetry]);

    useEffect(() => {
        return ws.onUnauthorized(() => void reauthenticate());
    }, [reauthenticate]);

    const authenticated = state.status === 'authenticated';
    useEffect(() => (authenticated ? startActivityBeacon() : undefined), [authenticated]);

    // Dans un espace d'une instance distante, `user` est le compte ouvert là-bas
    // (voir `stores/currentUser`) : ses membres, ses droits et ses curseurs
    // portent cet id, pas celui du compte d'ici.
    const acting = useActingUser();
    const value = useMemo<AuthContextValue>(
        () => ({ ...state, user: acting ?? state.user, unreachable, login, logout, refresh, updateUser }),
        [state, acting, unreachable, login, logout, refresh, updateUser]
    );

    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
    const ctx = useContext(AuthContext);
    if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
    return ctx;
}
