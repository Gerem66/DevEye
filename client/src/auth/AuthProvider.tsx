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
import { devicesProvider } from '../devicesProvider';

interface AuthState {
    status: 'unknown' | 'authenticated' | 'anonymous';
    user: User | null;
}

export interface LoginResult {
    twoFactorRequired: boolean;
}

interface AuthContextValue extends AuthState {
    login: (username: string, password: string) => Promise<LoginResult>;
    logout: () => Promise<void>;
    refresh: () => Promise<void>;
    updateUser: (patch: Partial<User>) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Applique un bundle de session. L'ordre compte : l'espace actif est publie avant
 * le theme et la disposition, ces deux stores resolvant leur cle de stockage a
 * partir de lui.
 */
function applyBundle(bundle: SessionBundle): AuthState {
    syncWorkspacesFromServer(bundle.workspaces, bundle.activeWorkspaceId, bundle.permissions);
    syncThemeFromServer(bundle.theme);
    syncHomeLayoutFromServer(bundle.homeLayout);
    return { status: 'authenticated', user: bundle.user };
}

export function AuthProvider({ children }: { children: ReactNode }) {
    const [state, setState] = useState<AuthState>({ status: 'unknown', user: null });
    // Le magasin `currentUser` suit l'état : c'est par lui que le barrel des modules
    // connaît l'utilisateur sans importer ce fournisseur.
    useEffect(() => {
        setCurrentUser(state.user);
    }, [state.user]);
    const refreshing = useRef<Promise<void> | null>(null);
    const reauthLock = useRef(false);

    const setAnonymous = useCallback(() => {
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
    }, []);

    const refresh = useCallback(async () => {
        if (refreshing.current) return refreshing.current;
        const task = (async () => {
            try {
                const bundle = await apiMe();
                setState(applyBundle(bundle));
                await ws.connect().catch(() => {});
                // Fire-and-forget: the secrecy state updates its store reactively and
                // nothing on the reveal path waits on it, so awaiting here would only
                // serialise an extra round-trip onto the critical load.
                void refreshSecrecyStatus();
            } catch (e) {
                if (e instanceof ApiError && (e.code === 'auth_required' || e.code === 'auth_expired')) {
                    try {
                        await apiRefresh();
                        const bundle = await apiMe();
                        setState(applyBundle(bundle));
                        await ws.connect().catch(() => {});
                        void refreshSecrecyStatus();
                        return;
                    } catch {
                        setAnonymous();
                        return;
                    }
                }
                setAnonymous();
            }
        })();
        refreshing.current = task;
        try {
            await task;
        } finally {
            refreshing.current = null;
        }
    }, [setAnonymous]);

    const login = useCallback(async (username: string, password: string): Promise<LoginResult> => {
        const bundle = await apiLogin({ username, password });
        if (bundle.twoFactorRequired) {
            return { twoFactorRequired: true };
        }
        setState(applyBundle(bundle));
        await ws.connect().catch(() => {});
        void refreshSecrecyStatus();
        return { twoFactorRequired: false };
    }, []);

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
            setState(applyBundle(await apiMe()));
            await ws.connect().catch(() => {});
            void refreshSecrecyStatus();
        } catch {
            setAnonymous();
        } finally {
            setTimeout(() => {
                reauthLock.current = false;
            }, 3000);
        }
    }, [setAnonymous]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    useEffect(() => {
        return ws.onUnauthorized(() => void reauthenticate());
    }, [reauthenticate]);

    const value = useMemo<AuthContextValue>(
        () => ({ ...state, login, logout, refresh, updateUser }),
        [state, login, logout, refresh, updateUser]
    );

    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
    const ctx = useContext(AuthContext);
    if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
    return ctx;
}
