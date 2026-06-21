import type { User, Workspace } from 'deveye-types';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError, login as apiLogin, logout as apiLogout, me as apiMe, refresh as apiRefresh } from '../api/http';
import { ws } from '../api/ws';
import { refreshSecrecyStatus, setUnlocked } from '../stores/secrecy';
import { resetHomeReady } from '../stores/homeReady';
import { syncThemeFromServer } from '../stores/theme';

interface AuthState {
    status: 'unknown' | 'authenticated' | 'anonymous';
    user: User | null;
    workspaces: Workspace[];
}

export interface LoginResult {
    twoFactorRequired: boolean;
}

interface AuthContextValue extends AuthState {
    login: (username: string, password: string) => Promise<LoginResult>;
    logout: () => Promise<void>;
    refresh: () => Promise<void>;
    updateUser: (patch: Partial<User>) => void;
    setWorkspaces: (updater: (prev: Workspace[]) => Workspace[]) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

type FullBundle = { user: User; workspaces: Workspace[] };

function applyBundle(bundle: FullBundle): AuthState {
    syncThemeFromServer(bundle.user.theme);
    return {
        status: 'authenticated',
        user: bundle.user,
        workspaces: bundle.workspaces
    };
}

export function AuthProvider({ children }: { children: ReactNode }) {
    const [state, setState] = useState<AuthState>({ status: 'unknown', user: null, workspaces: [] });
    const refreshing = useRef<Promise<void> | null>(null);

    const setAnonymous = useCallback(() => {
        setUnlocked(false);
        // Next sign-in must wait for the home's first data again before its splash
        // fades, instead of inheriting this session's "ready" flag.
        resetHomeReady();
        setState({ status: 'anonymous', user: null, workspaces: [] });
    }, []);

    const refresh = useCallback(async () => {
        if (refreshing.current) return refreshing.current;
        const task = (async () => {
            try {
                const bundle = await apiMe();
                setState(applyBundle(bundle));
                await ws.connect().catch(() => {});
                await refreshSecrecyStatus();
            } catch (e) {
                if (e instanceof ApiError && (e.code === 'auth_required' || e.code === 'auth_expired')) {
                    try {
                        await apiRefresh();
                        const bundle = await apiMe();
                        setState(applyBundle(bundle));
                        await ws.connect().catch(() => {});
                        await refreshSecrecyStatus();
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
        await refreshSecrecyStatus();
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

    const setWorkspaces = useCallback((updater: (prev: Workspace[]) => Workspace[]) => {
        setState((prev) => ({ ...prev, workspaces: updater(prev.workspaces) }));
    }, []);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    useEffect(() => {
        return ws.onUnauthorized(() => setAnonymous());
    }, [setAnonymous]);

    const value = useMemo<AuthContextValue>(
        () => ({ ...state, login, logout, refresh, updateUser, setWorkspaces }),
        [state, login, logout, refresh, updateUser, setWorkspaces]
    );

    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
    const ctx = useContext(AuthContext);
    if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
    return ctx;
}
