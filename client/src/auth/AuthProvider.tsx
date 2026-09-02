import type { SessionBundle, User } from '@deveye/types';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError, login as apiLogin, logout as apiLogout, me as apiMe, refresh as apiRefresh } from '../api/http';
import { ws } from '../api/ws';
import { refreshSecrecyStatus, setUnlocked } from '../stores/secrecy';
import { resetHomeReady } from '../stores/homeReady';
import { resetTheme, syncThemeFromServer } from '../stores/theme';
import { resetHomeLayout, syncHomeLayoutFromServer } from '../stores/homeLayout';
import { resetWorkspace, syncWorkspacesFromServer } from '../stores/workspace';
import { resetLive } from '../stores/live';
import { setCurrentUser } from '../stores/currentUser';
import { setFeedbackEnabled } from '../stores/feedbackEnabled';
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
 * Applique un bundle de session. L'ordre compte : l'espace actif est publie avant
 * le theme et la disposition, ces deux stores resolvant leur cle de stockage a
 * partir de lui.
 */
function applyBundle(bundle: SessionBundle): AuthState {
    syncWorkspacesFromServer(bundle.workspaces, bundle.activeWorkspaceId, bundle.permissions);
    syncThemeFromServer(bundle.theme);
    syncHomeLayoutFromServer(bundle.homeLayout);
    setFeedbackEnabled(bundle.feedbackEnabled);
    return { status: 'authenticated', user: bundle.user };
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
        resetTheme();
        resetHomeLayout();
        // La liste d'appareils est celle du module Appareils, quand il est là.
        devicesProvider()?.resetDevices();
        // Idem pour la presence, sans quoi la session suivante repartirait avec le
        // roster et le lieu declare de la precedente.
        resetLive();
        setState({ status: 'anonymous', user: null });
    }, [cancelRetry]);

    /** La session est ouverte : publier le bundle, rouvrir la socket, relire le secret. */
    const startSession = useCallback(
        async (bundle: SessionBundle) => {
            cancelRetry();
            setState(applyBundle(bundle));
            await ws.connect().catch(() => {});
            // Fire-and-forget: the secrecy state updates its store reactively and
            // nothing on the reveal path waits on it, so awaiting here would only
            // serialise an extra round-trip onto the critical load.
            void refreshSecrecyStatus();
        },
        [cancelRetry]
    );

    const refresh = useCallback(async () => {
        if (refreshing.current) return refreshing.current;
        const task = (async () => {
            try {
                await startSession(await apiMe());
            } catch (e) {
                if (e instanceof ApiError && (e.code === 'auth_required' || e.code === 'auth_expired')) {
                    try {
                        await apiRefresh();
                        await startSession(await apiMe());
                    } catch (renewal) {
                        if (isTransportFailure(renewal)) scheduleRetry();
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
    }, [setAnonymous, scheduleRetry, startSession]);

    const login = useCallback(
        async (username: string, password: string): Promise<LoginResult> => {
            const bundle = await apiLogin({ username, password });
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

    const value = useMemo<AuthContextValue>(
        () => ({ ...state, unreachable, login, logout, refresh, updateUser }),
        [state, unreachable, login, logout, refresh, updateUser]
    );

    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
    const ctx = useContext(AuthContext);
    if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
    return ctx;
}
