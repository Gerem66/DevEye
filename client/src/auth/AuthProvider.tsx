import type { SessionBundle, User } from 'deveye-types';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError, login as apiLogin, logout as apiLogout, me as apiMe, refresh as apiRefresh } from '../api/http';
import { ws } from '../api/ws';
import { refreshSecrecyStatus, setUnlocked } from '../stores/secrecy';
import { resetHomeReady } from '../stores/homeReady';
import { resetTheme, syncThemeFromServer } from '../stores/theme';
import { resetHomeLayout, syncHomeLayoutFromServer } from '../stores/homeLayout';
import { resetWorkspace, syncWorkspacesFromServer } from '../stores/workspace';
import { resetDevices } from '../stores/devices';

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
 * Applique un bundle de session.
 *
 * L'ordre compte : l'espace actif est publie AVANT le theme et la disposition,
 * car ces deux stores resolvent leur cle de stockage a partir de lui.
 */
function applyBundle(bundle: SessionBundle): AuthState {
    syncWorkspacesFromServer(bundle.workspaces, bundle.activeWorkspaceId);
    syncThemeFromServer(bundle.theme);
    syncHomeLayoutFromServer(bundle.homeLayout);
    return { status: 'authenticated', user: bundle.user };
}

export function AuthProvider({ children }: { children: ReactNode }) {
    const [state, setState] = useState<AuthState>({ status: 'unknown', user: null });
    const refreshing = useRef<Promise<void> | null>(null);
    const reauthLock = useRef(false);

    const setAnonymous = useCallback(() => {
        setUnlocked(false);
        // Next sign-in must wait for the home's first data again before its splash
        // fades, instead of inheriting this session's "ready" flag.
        resetHomeReady();
        // Sans ces trois remises a zero, se reconnecter avec un autre compte sur
        // la meme machine heriterait de l'espace, du theme et de l'accueil du
        // precedent — et estampillerait ses commandes avec un espace interdit.
        resetWorkspace();
        resetTheme();
        resetHomeLayout();
        resetDevices();
        setState({ status: 'anonymous', user: null });
    }, []);

    const refresh = useCallback(async () => {
        if (refreshing.current) return refreshing.current;
        const task = (async () => {
            try {
                const bundle = await apiMe();
                setState(applyBundle(bundle));
                await ws.connect().catch(() => {});
                // Fire-and-forget: the secrecy state updates its store reactively
                // and nothing on the reveal path waits on it, so awaiting here only
                // serialised an extra round-trip onto the critical load.
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

    // A WS `4401` only means the *access* token expired — typically while the tab
    // sat in the background. The refresh cookie is usually still valid, so instead
    // of dropping the user to the login screen we silently refresh the session and
    // reconnect the socket, keeping them on the populated dashboard. Only a failed
    // refresh (refresh token also gone) falls back to anonymous. The lock throttles
    // the pathological case where a freshly-refreshed socket is rejected again, so
    // we can't spin in a refresh/reconnect loop.
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
