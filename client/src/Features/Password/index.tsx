import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import styles from './style.module.css';

import LoadingTable from './loadingTable';
import PasswordRow, { type RowPassword } from './passwordRow';
import { PasswordPopupAdd, type PopupResult } from './popups-add-password';

import { OpenPopup } from '@/Components/Popup';
import { ws, WsError } from '@/api/ws';
import TextInput from '@/Components/TextInput';
import Button from '@/Components/Button';
import { ensureUnlocked as ensureSecrecyUnlocked, touchSecrecy, UnlockCancelledError } from '@/stores/secrecy';
import { invalidate } from '@/stores/invalidation';

import type { FeatureProps } from '@/Features/types';
import type { PasswordEntry, PasswordEntryMasked } from 'deveye-types';
import { useLiveSegment } from '@/live/useLiveSegment';

/**
 * Run a request, and if the server reports the password-encryption layer is
 * `locked`, open the global unlock prompt and retry once. Keeps every
 * encrypted-data call resilient without each call handling the prompt itself.
 */
async function withSecrecy<T>(run: () => Promise<T>): Promise<T> {
    try {
        const out = await run();
        touchSecrecy(); // slide the grace window on each successful action
        return out;
    } catch (e) {
        if (e instanceof WsError && e.code === 'locked') {
            await ensureSecrecyUnlocked();
            const out = await run();
            touchSecrecy();
            return out;
        }
        throw e;
    }
}

function humanizeError(e: unknown, fallback: string): string {
    if (e instanceof WsError) {
        if (e.code === 'auth_required' || e.code === 'locked') return 'Déverrouillage requis.';
        if (e.code === 'auth_invalid') return 'Mot de passe principal incorrect.';
        if (e.code === 'forbidden') return 'Accès refusé.';
    }
    return fallback;
}

function FeaturePassword({ workspace, closeFeature }: FeatureProps) {
    const [loaded, setLoaded] = useState(false);
    const [search, setSearch] = useState('');
    const [allPasswords, setAllPasswords] = useState<RowPassword[]>([]);
    const [actionError, setActionError] = useState<string | null>(null);
    /** L'entrée ouverte dans le formulaire — le niveau profond du coffre. */
    const [openEntryId, setOpenEntryId] = useState<number | null>(null);
    useLiveSegment('l1', openEntryId === null ? null : String(openEntryId));
    const reloadRef = useRef<Promise<void> | null>(null);
    // Read at call time so the load effect never depends on this changing prop.
    const closeFeatureRef = useRef(closeFeature);
    closeFeatureRef.current = closeFeature;

    const reload = useCallback(async () => {
        if (reloadRef.current) return reloadRef.current;
        const task = (async () => {
            try {
                const res = await withSecrecy(() => ws.send('password.list', {}));
                setAllPasswords(res.entries as PasswordEntryMasked[]);
            } catch (e) {
                setAllPasswords([]);
                // Nothing to show without the password: close instead of leaving
                // an empty, unusable view behind.
                if (e instanceof UnlockCancelledError) closeFeatureRef.current();
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
        setActionError(null);
        void reload();
    }, [reload]);

    /** Replace a single revealed entry inside the cache (used by reveal). */
    const replaceEntry = useCallback((entry: PasswordEntry) => {
        setAllPasswords((prev) => prev.map((p) => (p.id === entry.id ? entry : p)));
    }, []);

    /**
     * Upsert an entry into the cache in its MASKED form. Use after add/edit so a
     * freshly saved password is never left in clear in the table.
     */
    const upsertMasked = useCallback((entry: PasswordEntry) => {
        const masked: PasswordEntryMasked = { ...entry, password: '', hasPassword: entry.password !== '' };
        setAllPasswords((prev) => {
            const exists = prev.some((p) => p.id === masked.id);
            return exists ? prev.map((p) => (p.id === masked.id ? masked : p)) : [...prev, masked];
        });
    }, []);

    /** Mask a revealed entry back to its masked form. */
    const maskEntry = useCallback((id: number) => {
        setAllPasswords((prev) =>
            prev.map((p) => (p.id === id ? { ...p, password: '', hasPassword: p.password !== '' } : p))
        );
    }, []);

    const getPassword = useCallback(
        async (id: number) => {
            setActionError(null);
            try {
                const res = await withSecrecy(() => ws.send('password.get', { passwordId: id }));
                replaceEntry(res.entry);
            } catch (e) {
                setActionError(humanizeError(e, 'Impossible de récupérer le mot de passe.'));
            }
        },
        [workspace.id, replaceEntry]
    );

    /**
     * Fetch the clear password and copy it to the clipboard WITHOUT revealing it
     * in the table. Same unlock/grace logic as a reveal. Returns true on success
     * so the row can show its "copied" feedback.
     */
    const copyPassword = useCallback(
        async (id: number): Promise<boolean> => {
            setActionError(null);
            try {
                const res = await withSecrecy(() => ws.send('password.get', { passwordId: id }));
                await navigator.clipboard.writeText(res.entry.password);
                return true;
            } catch (e) {
                setActionError(humanizeError(e, 'Impossible de copier le mot de passe.'));
                return false;
            }
        },
        [workspace.id]
    );

    const openEditPopup = useCallback(
        async (id: number | null) => {
            setActionError(null);
            let initial: PasswordEntry | null = null;

            if (id !== null) {
                // Need the real entry (clear password) before editing.
                try {
                    const res = await withSecrecy(() => ws.send('password.get', { passwordId: id }));
                    // Hand the clear entry to the edit popup ONLY — never write it
                    // into `allPasswords`, or the table would reveal the password.
                    initial = res.entry;
                } catch (e) {
                    setActionError(humanizeError(e, 'Impossible de récupérer le mot de passe.'));
                    return;
                }
            }

            setOpenEntryId(id);
            const result = await OpenPopup<PopupResult>('popup-add-password', initial);
            setOpenEntryId(null);
            if (result === null) return;

            if (result === 'delete' && id !== null) {
                try {
                    await ws.send('password.delete', { passwordId: id });
                    setAllPasswords((prev) => prev.filter((p) => p.id !== id));
                    invalidate('password.count');
                } catch (e) {
                    setActionError(humanizeError(e, 'Suppression impossible.'));
                }
                return;
            }

            if (typeof result === 'object') {
                try {
                    if (id === null || result.id === 0) {
                        const { id: _omit, ...entry } = result;
                        void _omit;
                        const res = await withSecrecy(() => ws.send('password.add', { entry }));
                        upsertMasked(res.entry);
                        invalidate('password.count');
                    } else {
                        const res = await withSecrecy(() => ws.send('password.edit', { entry: result }));
                        upsertMasked(res.entry);
                    }
                } catch (e) {
                    setActionError(humanizeError(e, 'Enregistrement impossible.'));
                }
            }
        },
        [workspace.id, upsertMasked]
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

    const visibleCategories = Object.keys(categories).filter((c) => categories[c].length > 0);

    return (
        <div className={styles.container}>
            <header className={styles.header}>
                <div className={styles.headerText}>
                    <h2 className={styles.title}>Mots de passe</h2>
                    <p className={styles.subtitle}>
                        {allPasswords.length} entrée{allPasswords.length !== 1 ? 's' : ''} enregistrée
                        {allPasswords.length !== 1 ? 's' : ''}
                    </p>
                </div>
                <Button icon='plus' onClick={() => void openEditPopup(null)}>
                    Ajouter
                </Button>
            </header>

            <div className={styles.searchBar}>
                <TextInput
                    placeholder='Rechercher un service, un email, une catégorie…'
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                />
            </div>

            {actionError && <div className={styles.errorBanner}>{actionError}</div>}

            {!loaded && <LoadingTable />}

            {loaded &&
                visibleCategories.map((category) => (
                    <section key={category} className={styles.categoryCard}>
                        <h3 className={styles.categoryTitle}>
                            {category}
                            <span className={styles.count}>{categories[category].length}</span>
                        </h3>
                        <div className={styles.tableWrap}>
                            <table className={styles.table}>
                                <thead>
                                    <tr>
                                        <th style={{ width: '20%' }}>Service</th>
                                        <th>{"Nom d'utilisateur / Email"}</th>
                                        <th style={{ width: '20%' }}>Mot de passe</th>
                                        <th style={{ width: '10%' }}>Statut</th>
                                        <th style={{ width: '5%' }}></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {categories[category].map((password) => (
                                        <PasswordRow
                                            key={password.id}
                                            password={password}
                                            onEdit={(id) => void openEditPopup(id)}
                                            onReveal={(id) => void getPassword(id)}
                                            onMask={maskEntry}
                                            onCopyPassword={copyPassword}
                                        />
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </section>
                ))}

            {loaded && visibleCategories.length === 0 && (
                <div className={styles.empty}>
                    <span className={styles.emptyIcon}>🔒</span>
                    <p>{search ? 'Aucun résultat' : 'Aucun mot de passe trouvé'}</p>
                </div>
            )}

            <PasswordPopupAdd passwordCategories={Object.keys(categories)} />
        </div>
    );
}

export default FeaturePassword;
