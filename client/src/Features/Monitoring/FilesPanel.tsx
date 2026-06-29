import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ws } from '@/api/ws';
import { acquireMetrics } from '@/stores/metricsSubscription';
import Button from '@/Components/Button';
import TextInput from '@/Components/TextInput';
import SelectInput from '@/Components/SelectInput';
import { Dialog } from '@/Components/Dialog';
import {
    DEVICE_FILES_LISTING_EVENT,
    DEVICE_FILES_MATCHES_EVENT,
    DEVICE_FILES_OP_EVENT,
    DEVICE_FILES_USAGE_EVENT,
    type DeviceFilesListingPush,
    type DeviceFilesMatchesPush,
    type DeviceFilesOpPush,
    type DeviceFilesUsagePush,
    type FileEntry,
    type FileListing,
    type FileMatch,
    type FileSearchField,
    type FileSearchFilter,
    type FileUsageEntry
} from 'deveye-types';
import { formatBytes } from './utils';
import styles from './Monitoring.module.css';

/** Join a directory path with a child name, keeping the path's separator style. */
function joinPath(base: string, name: string): string {
    if (base.endsWith('/') || base.endsWith('\\')) return base + name;
    const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
    return base + sep + name;
}

/** Render unix permission bits as `rwxr-xr-x` (empty when unknown). */
function permString(mode: number | null): string {
    if (mode == null) return '';
    const part = (n: number) => `${n & 4 ? 'r' : '-'}${n & 2 ? 'w' : '-'}${n & 1 ? 'x' : '-'}`;
    return part((mode >> 6) & 7) + part((mode >> 3) & 7) + part(mode & 7);
}

const iconFor = (kind: string) => (kind === 'dir' ? 'icon-folder' : kind === 'symlink' ? 'icon-arrow' : 'icon-file');

function fmtDate(ms: number | null): string {
    return ms ? new Date(ms).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit' }) : '';
}

const SEARCH_FIELDS: { value: FileSearchField; label: string }[] = [
    { value: 'name', label: 'Nom' },
    { value: 'extension', label: 'Extension' },
    { value: 'content', label: 'Contenu' }
];

/** Local search-form state (mirrors the wire filter, with UI-friendly units). */
interface SearchForm {
    query: string;
    field: FileSearchField;
    regex: boolean;
    since: string; // yyyy-mm-dd
    until: string;
    minMb: string;
    maxMb: string;
}
const EMPTY_SEARCH: SearchForm = { query: '', field: 'name', regex: false, since: '', until: '', minMb: '', maxMb: '' };

/**
 * Graphical file explorer for one device, in the spirit of ncdu: browse the
 * filesystem, visualise recursive disk usage as bars to find what to clean, run
 * advanced searches (name/extension/content + date & size windows), and tidy up
 * (new folder / rename / delete). All ops stream over the device push channel,
 * correlated by an `opId`.
 */
export function FilesPanel({ deviceId }: { deviceId: string }) {
    const [path, setPath] = useState('/');
    const [pathInput, setPathInput] = useState('/');
    const [listing, setListing] = useState<FileListing | null>(null);
    const [usage, setUsage] = useState<Map<string, FileUsageEntry> | null>(null);
    const [analyzing, setAnalyzing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    const [searchMode, setSearchMode] = useState(false);
    const [form, setForm] = useState<SearchForm>(EMPTY_SEARCH);
    const [matches, setMatches] = useState<FileMatch[] | null>(null);
    const [truncated, setTruncated] = useState(false);
    const [searching, setSearching] = useState(false);

    const [confirmDelete, setConfirmDelete] = useState<FileEntry | null>(null);
    const [nameDialog, setNameDialog] = useState<{ mode: 'mkdir' | 'rename'; entry?: FileEntry } | null>(null);
    const [nameValue, setNameValue] = useState('');

    const listOp = useRef('');
    const usageOp = useRef('');
    const searchOp = useRef('');
    const mutateOp = useRef('');

    useEffect(() => acquireMetrics(deviceId), [deviceId]);

    const analyze = useCallback(
        (target: string) => {
            const opId = crypto.randomUUID();
            usageOp.current = opId;
            setAnalyzing(true);
            void ws.send('device.filesAnalyze', { deviceId, opId, path: target }).catch(() => setAnalyzing(false));
        },
        [deviceId]
    );

    const navigate = useCallback(
        (target: string) => {
            const opId = crypto.randomUUID();
            listOp.current = opId;
            setLoading(true);
            setError(null);
            setUsage(null);
            void ws.send('device.filesList', { deviceId, opId, path: target }).catch((e) => {
                setLoading(false);
                setError(e instanceof Error ? e.message : 'Échec');
            });
        },
        [deviceId]
    );

    // Initial load + reset on device change.
    useEffect(() => {
        setPath('/');
        setPathInput('/');
        setSearchMode(false);
        setMatches(null);
        navigate('/');
    }, [deviceId, navigate]);

    // Single push router for all file events, correlated by opId.
    useEffect(() => {
        const off = ws.onMessage((msg) => {
            if (msg.command === DEVICE_FILES_LISTING_EVENT && msg.payload.ok) {
                const d = msg.payload.data as DeviceFilesListingPush;
                if (d.deviceId !== deviceId || d.opId !== listOp.current) return;
                setLoading(false);
                if (d.error || !d.listing) {
                    setError(d.error ?? 'Dossier illisible');
                    return;
                }
                setError(null);
                setListing(d.listing);
                setPath(d.listing.path);
                setPathInput(d.listing.path);
                analyze(d.listing.path); // auto ncdu pass (bounded)
            } else if (msg.command === DEVICE_FILES_USAGE_EVENT && msg.payload.ok) {
                const d = msg.payload.data as DeviceFilesUsagePush;
                if (d.deviceId !== deviceId || d.opId !== usageOp.current) return;
                setAnalyzing(false);
                if (!d.error) setUsage(new Map(d.entries.map((e) => [e.name, e])));
            } else if (msg.command === DEVICE_FILES_MATCHES_EVENT && msg.payload.ok) {
                const d = msg.payload.data as DeviceFilesMatchesPush;
                if (d.deviceId !== deviceId || d.opId !== searchOp.current) return;
                setSearching(false);
                setMatches(d.error ? [] : d.matches);
                setTruncated(d.truncated);
                if (d.error) setError(d.error);
            } else if (msg.command === DEVICE_FILES_OP_EVENT && msg.payload.ok) {
                const d = msg.payload.data as DeviceFilesOpPush;
                if (d.deviceId !== deviceId || d.opId !== mutateOp.current) return;
                if (d.ok) navigate(path);
                else setError(d.error ?? 'Opération échouée');
            }
        });
        return off;
    }, [deviceId, analyze, navigate, path]);

    const mutate = useCallback(
        (op: 'delete' | 'mkdir' | 'rename', target: string, dest?: string) => {
            const opId = crypto.randomUUID();
            mutateOp.current = opId;
            setError(null);
            void ws
                .send('device.filesMutate', { deviceId, opId, op, path: target, dest })
                .catch((e) => setError(e instanceof Error ? e.message : 'Échec'));
        },
        [deviceId]
    );

    const runSearch = useCallback(() => {
        const filter: FileSearchFilter = {};
        if (form.query.trim()) filter.query = form.query.trim();
        if (form.field !== 'name') filter.field = form.field;
        if (form.regex && form.field !== 'extension') filter.regex = true;
        if (form.since) filter.since = Math.floor(new Date(form.since).getTime() / 1000);
        if (form.until) filter.until = Math.floor(new Date(form.until + 'T23:59:59').getTime() / 1000);
        if (form.minMb) filter.minSize = Math.round(parseFloat(form.minMb) * 1_000_000);
        if (form.maxMb) filter.maxSize = Math.round(parseFloat(form.maxMb) * 1_000_000);
        const opId = crypto.randomUUID();
        searchOp.current = opId;
        setSearching(true);
        setMatches(null);
        setError(null);
        void ws.send('device.filesSearch', { deviceId, opId, path, filter }).catch((e) => {
            setSearching(false);
            setError(e instanceof Error ? e.message : 'Échec');
        });
    }, [deviceId, path, form]);

    // Entries with their display size (recursive when analysed) + the max for bars.
    const rows = useMemo(() => {
        const entries = listing?.entries ?? [];
        const withSize = entries.map((e) => {
            const u = usage?.get(e.name);
            return { entry: e, size: u ? u.totalSize : e.size, partial: u?.partial ?? false };
        });
        if (usage) withSize.sort((a, b) => b.size - a.size);
        const max = withSize.reduce((m, r) => Math.max(m, r.size), 0) || 1;
        return { withSize, max };
    }, [listing, usage]);

    const breadcrumb = useMemo(() => {
        const sep = path.includes('\\') && !path.includes('/') ? '\\' : '/';
        const parts = path.split(sep).filter(Boolean);
        const acc: { label: string; full: string }[] = [];
        let cur = sep === '/' ? '' : '';
        for (const p of parts) {
            cur = cur + sep + p;
            acc.push({ label: p, full: sep === '/' ? cur : cur.replace(/^\\/, '') });
        }
        return acc;
    }, [path]);

    return (
        <div className={styles.filesPanel}>
            {/* Path bar */}
            <div className={styles.filesPathBar}>
                <button
                    type='button'
                    className={styles.filesIconBtn}
                    title='Dossier parent'
                    disabled={!listing?.parent}
                    onClick={() => listing?.parent && navigate(listing.parent)}
                >
                    <span className='icon icon-arrow-left' />
                </button>
                <div className={styles.filesBreadcrumb}>
                    <button type='button' className={styles.filesCrumb} onClick={() => navigate('/')}>
                        /
                    </button>
                    {breadcrumb.map((c) => (
                        <button
                            key={c.full}
                            type='button'
                            className={styles.filesCrumb}
                            onClick={() => navigate(c.full)}
                        >
                            {c.label}
                        </button>
                    ))}
                </div>
                <button type='button' className={styles.filesIconBtn} title='Actualiser' onClick={() => navigate(path)}>
                    <span className={`icon icon-refresh ${loading ? styles.spinning : ''}`} />
                </button>
            </div>

            {/* Toolbar */}
            <div className={styles.filesToolbar}>
                <TextInput
                    value={pathInput}
                    onChange={(e) => setPathInput(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') navigate(pathInput.trim());
                    }}
                    placeholder='/chemin/absolu'
                    className={styles.filesPathInput}
                />
                <Button variant='secondary' onClick={() => navigate(pathInput.trim())}>
                    Aller
                </Button>
                <button
                    type='button'
                    className={`${styles.logToggle} ${searchMode ? styles.logToggleOn : ''}`}
                    onClick={() => setSearchMode((v) => !v)}
                >
                    <span className='icon icon-details' /> Rechercher
                </button>
                <button
                    type='button'
                    className={styles.logToggle}
                    onClick={() => {
                        setNameValue('');
                        setNameDialog({ mode: 'mkdir' });
                    }}
                >
                    <span className='icon icon-folder-plus' /> Nouveau dossier
                </button>
                <span className={styles.filesUsageState}>
                    {analyzing ? 'Analyse de l’espace…' : usage ? 'Taille = récursive' : ''}
                </span>
            </div>

            {error && <p className={styles.filesError}>{error}</p>}

            {searchMode ? (
                <SearchView
                    form={form}
                    setForm={setForm}
                    onSearch={runSearch}
                    searching={searching}
                    matches={matches}
                    truncated={truncated}
                    onOpen={(m) => {
                        const sep = m.path.includes('\\') && !m.path.includes('/') ? '\\' : '/';
                        const parent = m.path.slice(0, m.path.lastIndexOf(sep)) || sep;
                        setSearchMode(false);
                        navigate(m.kind === 'dir' ? m.path : parent);
                    }}
                />
            ) : (
                <div className={styles.filesList}>
                    {rows.withSize.length === 0 && !loading ? (
                        <p className={styles.logHint}>Dossier vide.</p>
                    ) : (
                        rows.withSize.map(({ entry, size, partial }) => (
                            <div key={entry.name} className={styles.filesRow}>
                                <button
                                    type='button'
                                    className={styles.filesRowMain}
                                    onClick={() => entry.kind === 'dir' && navigate(joinPath(path, entry.name))}
                                    disabled={entry.kind !== 'dir'}
                                    title={entry.symlinkTarget ? `→ ${entry.symlinkTarget}` : entry.name}
                                >
                                    <span className={`icon ${iconFor(entry.kind)} ${styles.filesRowIcon}`} />
                                    <span className={styles.filesName}>{entry.name}</span>
                                    <span className={styles.filesBarTrack}>
                                        <span
                                            className={styles.filesBarFill}
                                            style={{ width: `${Math.round((size / rows.max) * 100)}%` }}
                                        />
                                    </span>
                                    <span className={styles.filesSize}>
                                        {formatBytes(size)}
                                        {partial ? '+' : ''}
                                    </span>
                                    <span className={styles.filesMeta}>{fmtDate(entry.mtime)}</span>
                                    <span className={styles.filesPerm}>{permString(entry.mode)}</span>
                                </button>
                                <div className={styles.filesRowActions}>
                                    <button
                                        type='button'
                                        title='Renommer'
                                        onClick={() => {
                                            setNameValue(entry.name);
                                            setNameDialog({ mode: 'rename', entry });
                                        }}
                                    >
                                        <span className='icon icon-edit' />
                                    </button>
                                    <button
                                        type='button'
                                        className={styles.filesDeleteBtn}
                                        title='Supprimer'
                                        onClick={() => setConfirmDelete(entry)}
                                    >
                                        <span className='icon icon-trash' />
                                    </button>
                                </div>
                            </div>
                        ))
                    )}
                </div>
            )}

            {/* Delete confirmation */}
            <Dialog
                open={confirmDelete !== null}
                onClose={() => setConfirmDelete(null)}
                title='Supprimer ?'
                description='Cette action est définitive (les dossiers sont supprimés récursivement).'
                onSubmit={() => {
                    if (confirmDelete) mutate('delete', joinPath(path, confirmDelete.name));
                    setConfirmDelete(null);
                }}
                footer={
                    <>
                        <Button variant='secondary' onClick={() => setConfirmDelete(null)}>
                            Annuler
                        </Button>
                        <Button
                            variant='danger'
                            onClick={() => {
                                if (confirmDelete) mutate('delete', joinPath(path, confirmDelete.name));
                                setConfirmDelete(null);
                            }}
                        >
                            Supprimer
                        </Button>
                    </>
                }
            >
                <p className={styles.focusCaption}>
                    {confirmDelete ? `« ${confirmDelete.name} » sera supprimé de ${path}.` : ''}
                </p>
            </Dialog>

            {/* New folder / rename */}
            <Dialog
                open={nameDialog !== null}
                onClose={() => setNameDialog(null)}
                title={nameDialog?.mode === 'mkdir' ? 'Nouveau dossier' : 'Renommer'}
                onSubmit={() => {
                    const v = nameValue.trim();
                    if (!v || !nameDialog) return;
                    if (nameDialog.mode === 'mkdir') mutate('mkdir', joinPath(path, v));
                    else if (nameDialog.entry)
                        mutate('rename', joinPath(path, nameDialog.entry.name), joinPath(path, v));
                    setNameDialog(null);
                }}
                footer={
                    <>
                        <Button variant='secondary' onClick={() => setNameDialog(null)}>
                            Annuler
                        </Button>
                        <Button
                            onClick={() => {
                                const v = nameValue.trim();
                                if (!v || !nameDialog) return;
                                if (nameDialog.mode === 'mkdir') mutate('mkdir', joinPath(path, v));
                                else if (nameDialog.entry)
                                    mutate('rename', joinPath(path, nameDialog.entry.name), joinPath(path, v));
                                setNameDialog(null);
                            }}
                        >
                            {nameDialog?.mode === 'mkdir' ? 'Créer' : 'Renommer'}
                        </Button>
                    </>
                }
            >
                <TextInput value={nameValue} onChange={(e) => setNameValue(e.target.value)} placeholder='Nom' />
            </Dialog>
        </div>
    );
}

/** Advanced search form + results. Split out to keep the explorer readable. */
function SearchView({
    form,
    setForm,
    onSearch,
    searching,
    matches,
    truncated,
    onOpen
}: {
    form: SearchForm;
    setForm: (f: SearchForm) => void;
    onSearch: () => void;
    searching: boolean;
    matches: FileMatch[] | null;
    truncated: boolean;
    onOpen: (m: FileMatch) => void;
}) {
    const set = <K extends keyof SearchForm>(k: K, v: SearchForm[K]) => setForm({ ...form, [k]: v });
    return (
        <div className={styles.filesSearch}>
            <div className={styles.filesSearchRow}>
                <TextInput
                    value={form.query}
                    onChange={(e) => set('query', e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && onSearch()}
                    placeholder={form.field === 'extension' ? 'ex. log, png…' : 'Texte à rechercher'}
                    className={styles.filesSearchInput}
                />
                <SelectInput value={form.field} onChange={(e) => set('field', e.target.value as FileSearchField)}>
                    {SEARCH_FIELDS.map((f) => (
                        <option key={f.value} value={f.value}>
                            {f.label}
                        </option>
                    ))}
                </SelectInput>
                {form.field !== 'extension' && (
                    <button
                        type='button'
                        className={`${styles.logToggle} ${form.regex ? styles.logToggleOn : ''}`}
                        onClick={() => set('regex', !form.regex)}
                        title='Expression régulière'
                    >
                        .*
                    </button>
                )}
                <Button onClick={onSearch} disabled={searching}>
                    {searching ? '…' : 'Rechercher'}
                </Button>
            </div>
            <div className={styles.filesSearchRow}>
                <label className={styles.filesField}>
                    Modifié après
                    <input type='date' value={form.since} onChange={(e) => set('since', e.target.value)} />
                </label>
                <label className={styles.filesField}>
                    avant
                    <input type='date' value={form.until} onChange={(e) => set('until', e.target.value)} />
                </label>
                <label className={styles.filesField}>
                    Taille ≥ (Mo)
                    <input
                        type='number'
                        min='0'
                        value={form.minMb}
                        onChange={(e) => set('minMb', e.target.value)}
                        className={styles.filesNum}
                    />
                </label>
                <label className={styles.filesField}>
                    ≤ (Mo)
                    <input
                        type='number'
                        min='0'
                        value={form.maxMb}
                        onChange={(e) => set('maxMb', e.target.value)}
                        className={styles.filesNum}
                    />
                </label>
            </div>

            <div className={styles.filesList}>
                {matches === null ? (
                    <p className={styles.logHint}>Lance une recherche dans le dossier courant et ses sous-dossiers.</p>
                ) : matches.length === 0 ? (
                    <p className={styles.logHint}>Aucun résultat.</p>
                ) : (
                    <>
                        {truncated && (
                            <p className={styles.filesTruncated}>Résultats tronqués (trop de correspondances).</p>
                        )}
                        {matches.map((m) => (
                            <button key={m.path} type='button' className={styles.filesMatch} onClick={() => onOpen(m)}>
                                <span className={`icon ${iconFor(m.kind)} ${styles.filesRowIcon}`} />
                                <span className={styles.filesMatchPath}>
                                    <span className={styles.filesName}>{m.path}</span>
                                    {m.preview && <span className={styles.filesPreview}>{m.preview}</span>}
                                </span>
                                <span className={styles.filesSize}>{formatBytes(m.size)}</span>
                                <span className={styles.filesMeta}>{fmtDate(m.mtime)}</span>
                            </button>
                        ))}
                    </>
                )}
            </div>
        </div>
    );
}
