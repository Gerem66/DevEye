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

function FeaturePassword({ user, workspace, feature }: FeatureProps) {
    const [loaded, setLoaded] = useState(false);
    const [search, setSearch] = useState('');
    const [allPasswords, setAllPasswords] = useState<RowPassword[]>([]);
    const reloadRef = useRef<Promise<void> | null>(null);

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
        setLoaded(false);
        setAllPasswords([]);
        void reload();
    }, [reload]);

    /** Replace a single entry inside the cache, used after on-demand unlock. */
    const replaceEntry = useCallback((entry: PasswordEntry) => {
        setAllPasswords((prev) => prev.map((p) => (p.id === entry.id ? entry : p)));
    }, []);

    const getPassword = useCallback(
        async (id: number) => {
            const run = async () => {
                const res = await ws.send('password.get', { workspaceId: workspace.id, passwordId: id });
                replaceEntry(res.entry);
            };
            try {
                await run();
            } catch (e) {
                if (e instanceof WsError && e.code === 'auth_required') {
                    const unlocked = await OpenPopup<boolean>('popup-unlock');
                    if (unlocked) await run().catch(() => {});
                }
            }
        },
        [workspace.id, replaceEntry]
    );

    const openEditPopup = useCallback(
        async (id: number | null) => {
            let initial: PasswordEntry | null = null;

            if (id !== null) {
                // Need the real entry (clear password) before editing
                try {
                    const res = await ws.send('password.get', { workspaceId: workspace.id, passwordId: id });
                    initial = res.entry;
                } catch (e) {
                    if (e instanceof WsError && e.code === 'auth_required') {
                        const unlocked = await OpenPopup<boolean>('popup-unlock');
                        if (!unlocked) return;
                        try {
                            const res = await ws.send('password.get', { workspaceId: workspace.id, passwordId: id });
                            initial = res.entry;
                        } catch {
                            return;
                        }
                    } else {
                        return;
                    }
                }
                if (initial) replaceEntry(initial);
            }

            const result = await OpenPopup<PopupResult>('popup-add-password', initial);
            if (result === null) return;

            if (result === 'delete' && id !== null) {
                try {
                    await ws.send('password.delete', { workspaceId: workspace.id, passwordId: id });
                    setAllPasswords((prev) => prev.filter((p) => p.id !== id));
                } catch {
                    /* ignore */
                }
                return;
            }

            if (typeof result === 'object') {
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
                } catch {
                    /* ignore */
                }
            }
        },
        [workspace.id, replaceEntry]
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
