import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import styles from './style.module.css';

import LoadingTable from './loadingTable';
import PasswordRow, { type RowPassword } from './passwordRow';
import { PasswordPopupAdd, type PopupResult } from './popups-add-password';

import { OpenPopup } from '@/Components/Popup';
import { ws, WsError } from '@/api/ws';
import { Card, Header, Row, TextInput } from '../../Components';

import type { FeatureProps } from '@/Features/types';
import type { PasswordEntry, PasswordEntryMasked } from 'deveye-types';

function humanizeError(e: unknown, fallback: string): string {
    if (e instanceof WsError) {
        if (e.code === 'auth_required') return 'Déverrouillage requis.';
        if (e.code === 'auth_invalid') return 'Mot de passe principal incorrect.';
        if (e.code === 'forbidden') return 'Accès refusé.';
    }
    return fallback;
}

function FeaturePassword({ user, workspace, feature }: FeatureProps) {
    const [loaded, setLoaded] = useState(false);
    const [search, setSearch] = useState('');
    const [allPasswords, setAllPasswords] = useState<RowPassword[]>([]);
    const [actionError, setActionError] = useState<string | null>(null);
    const reloadRef = useRef<Promise<void> | null>(null);
    const unlockedRef = useRef(false);

    const reload = useCallback(async () => {
        if (reloadRef.current) return reloadRef.current;
        const task = (async () => {
            try {
                const res = await ws.send('password.list', { workspaceId: workspace.id });
                setAllPasswords(res.entries as PasswordEntryMasked[]);
            } catch {
                setAllPasswords([]);
            } finally {
                setLoaded(true);
            }
        })();
        reloadRef.current = task;
        try {
            await task;
        } finally {
            reloadRef.current = null;
        }
    }, [workspace.id]);

    useEffect(() => {
        unlockedRef.current = false;
        setLoaded(false);
        setAllPasswords([]);
        setActionError(null);
        void reload();
    }, [reload]);

    /**
     * Ensure the workspace is unlocked before a reveal/add/edit. Personal and
     * password-less workspaces unlock transparently (no prompt); protected ones
     * ask for the master password via the unlock popup.
     */
    const ensureUnlocked = useCallback(async (): Promise<boolean> => {
        if (unlockedRef.current) return true;
        try {
            await ws.send('password.unlock', { workspaceId: workspace.id, password: '' });
            unlockedRef.current = true;
            return true;
        } catch {
            const ok = await OpenPopup<boolean>('popup-unlock');
            if (ok) unlockedRef.current = true;
            return ok === true;
        }
    }, [workspace.id]);

    /** Replace a single entry inside the cache, used after on-demand unlock. */
    const replaceEntry = useCallback((entry: PasswordEntry) => {
        setAllPasswords((prev) => prev.map((p) => (p.id === entry.id ? entry : p)));
    }, []);

    const getPassword = useCallback(
        async (id: number) => {
            setActionError(null);
            if (!(await ensureUnlocked())) return;
            try {
                const res = await ws.send('password.get', { workspaceId: workspace.id, passwordId: id });
                replaceEntry(res.entry);
            } catch (e) {
                setActionError(humanizeError(e, 'Impossible de récupérer le mot de passe.'));
            }
        },
        [ensureUnlocked, workspace.id, replaceEntry]
    );

    const openEditPopup = useCallback(
        async (id: number | null) => {
            setActionError(null);
            let initial: PasswordEntry | null = null;

            if (id !== null) {
                // Need the real entry (clear password) before editing.
                if (!(await ensureUnlocked())) return;
                try {
                    const res = await ws.send('password.get', { workspaceId: workspace.id, passwordId: id });
                    initial = res.entry;
                    replaceEntry(initial);
                } catch (e) {
                    setActionError(humanizeError(e, 'Impossible de récupérer le mot de passe.'));
                    return;
                }
            }

            const result = await OpenPopup<PopupResult>('popup-add-password', initial);
            if (result === null) return;

            if (result === 'delete' && id !== null) {
                try {
                    await ws.send('password.delete', { workspaceId: workspace.id, passwordId: id });
                    setAllPasswords((prev) => prev.filter((p) => p.id !== id));
                } catch (e) {
                    setActionError(humanizeError(e, 'Suppression impossible.'));
                }
                return;
            }

            if (typeof result === 'object') {
                if (!(await ensureUnlocked())) return;
                try {
                    if (id === null || result.id === 0) {
                        const { id: _omit, ...entry } = result;
                        void _omit;
                        const res = await ws.send('password.add', { workspaceId: workspace.id, entry });
                        setAllPasswords((prev) => [...prev, res.entry]);
                    } else {
                        const res = await ws.send('password.edit', {
                            workspaceId: workspace.id,
                            entry: result
                        });
                        replaceEntry(res.entry);
                    }
                } catch (e) {
                    setActionError(humanizeError(e, 'Enregistrement impossible.'));
                }
            }
        },
        [ensureUnlocked, workspace.id, replaceEntry]
    );

    /** Categories grouped + filtered by search. */
    const categories = useMemo<Record<string, RowPassword[]>>(() => {
        const lowerSearch = search.trim().toLowerCase();
        const filtered = lowerSearch
            ? allPasswords.filter(
                  (p) =>
                      p.service.toLowerCase().includes(lowerSearch) ||
                      p.email.toLowerCase().includes(lowerSearch) ||
                      p.category.toLowerCase().includes(lowerSearch)
              )
            : allPasswords;
        const out: Record<string, RowPassword[]> = {};
        for (const entry of filtered) {
            const key = entry.category || 'Autres';
            (out[key] ||= []).push(entry);
        }
        return out;
    }, [allPasswords, search]);

    return (
        <div className={styles.profile}>
            <Header user={user} workspace={workspace} feature={feature} />

            <Row center>
                <Card.Element
                    title={`Rechercher (${allPasswords.length})`}
                    style={styles['search-container']}
                    color='bg-blue-dark'
                    width={500}
                >
                    <a className={`link ${styles['add-password']}`} onClick={() => void openEditPopup(null)}>
                        Ajouter un mot de passe
                    </a>
                    <TextInput
                        placeholder="Nom d'un service"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                    />
                </Card.Element>
            </Row>

            {actionError && (
                <Row center>
                    <div className={styles['action-error']}>{actionError}</div>
                </Row>
            )}

            {!loaded && (
                <>
                    <LoadingTable key='loading-table-password-1' />
                    <LoadingTable key='loading-table-password-2' />
                </>
            )}

            {loaded &&
                Object.keys(categories).map((category) => {
                    const passwords = categories[category];
                    if (passwords.length === 0) return null;

                    return (
                        <Row key={category} center>
                            <Card.Element
                                title={`${category} (${passwords.length})`}
                                width={1000}
                                color='bg-blue-dark'
                                style={styles['password-container']}
                            >
                                <div className={styles['scroll-mode']}>
                                    <table className={`show-lines ${styles['scroll-mode']}`}>
                                        <thead>
                                            <tr>
                                                <th style={{ width: '20%' }}>Service</th>
                                                <th>{"Nom d'utilisateur / Email"}</th>
                                                <th style={{ width: '20%' }}>Mot de passe</th>
                                                <th style={{ width: '10%' }}>Status</th>
                                                <th style={{ width: '5%' }}></th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {passwords.map((password) => (
                                                <PasswordRow
                                                    key={password.id}
                                                    password={password}
                                                    onEdit={(id) => void openEditPopup(id)}
                                                    callback={(id) => void getPassword(id)}
                                                />
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </Card.Element>
                        </Row>
                    );
                })}

            <PasswordPopupAdd passwordCategories={Object.keys(categories)} />
        </div>
    );
}

export default FeaturePassword;
