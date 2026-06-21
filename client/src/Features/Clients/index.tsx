import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ws } from '@/api/ws';
import { del, get, patch, post } from '@/api/http';
import { StatusBadge, type BadgeTone } from '@/Components/StatusBadge';
import { Dialog } from '@/Components/Dialog';
import { openInfo } from '@/Components/InfoPopup';
import Button from '@/Components/Button';
import SelectInput from '@/Components/SelectInput';
import TextInput from '@/Components/TextInput';
import { useDevices } from '@/stores/devices';
import { LinkInfo } from './LinkInfo';
import { DownloadAgent } from './DownloadAgent';
import {
    LINK_CODE_TTL_MAX_SECONDS,
    linkCodeResponseSchema,
    linkCodesListResponseSchema,
    type DeviceStatus,
    type LinkCodeResponse
} from 'deveye-types';
import type { FeatureProps } from '../types';
import styles from './Clients.module.css';

/** Localized lifecycle label + badge tone for a device status. */
function statusMeta(status: DeviceStatus): { label: string; tone: BadgeTone } {
    switch (status) {
        case 'pending':
            return { label: 'En attente', tone: 'warning' };
        case 'active':
            return { label: 'Approuvé', tone: 'success' };
        case 'revoked':
            return { label: 'Révoqué', tone: 'danger' };
        case 'pending_deletion':
            return { label: 'Suppression en attente', tone: 'warning' };
        case 'archived':
            return { label: 'Archivé', tone: 'neutral' };
    }
}

/** Human-readable validity for a link code (`null` = never expires). */
function formatExpiry(expiresAt: number | null): string {
    if (expiresAt === null) return 'N’expire pas';
    const secs = expiresAt - Math.floor(Date.now() / 1000);
    if (secs <= 0) return 'Expiré';
    const mins = Math.ceil(secs / 60);
    if (mins < 60) return `Expire dans ${mins} min`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `Expire dans ${hours} h`;
    return `Expire le ${new Date(expiresAt * 1000).toLocaleDateString('fr-FR')}`;
}

function formatLastSeen(ts: number | null): string {
    if (ts === null) return 'Jamais';
    // `lastSeen` is stored in seconds; bring it to ms before diffing.
    const diffMs = Date.now() - ts * 1000;
    const minutes = Math.floor(diffMs / 60000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    if (minutes < 1) return "À l'instant";
    if (minutes < 60) return `Il y a ${minutes} min`;
    if (hours < 24) return `Il y a ${hours}h`;
    return `Il y a ${days}j`;
}

/** DA-styled on/off switch (replaces the native checkbox). */
function Switch({
    checked,
    onChange,
    label,
    hint
}: {
    checked: boolean;
    onChange: (v: boolean) => void;
    label: string;
    hint?: string;
}) {
    return (
        <button
            type='button'
            role='switch'
            aria-checked={checked}
            className={`${styles.switch} ${checked ? styles.switchOn : ''}`}
            onClick={() => onChange(!checked)}
        >
            <span className={styles.switchTrack}>
                <span className={styles.switchThumb} />
            </span>
            <span className={styles.switchText}>
                {label}
                {hint && <span className={styles.switchHint}>{hint}</span>}
            </span>
        </button>
    );
}

export default function Clients({ user: _user, workspace: _ws }: FeatureProps) {
    const { devices, loading, error, refresh } = useDevices();
    const [codes, setCodes] = useState<LinkCodeResponse[]>([]);
    const [showLinkModal, setShowLinkModal] = useState(false);
    const [showDownloadModal, setShowDownloadModal] = useState(false);
    const [generatingCode, setGeneratingCode] = useState(false);
    const [actionError, setActionError] = useState<string | null>(null);
    const [genError, setGenError] = useState<string | null>(null);
    const [copiedCode, setCopiedCode] = useState<string | null>(null);
    // Device pending a deletion confirmation (the explanatory dialog).
    const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
    const [deleting, setDeleting] = useState(false);
    // Device pending a "delete without waiting" (force-archive) confirmation.
    const [forceTarget, setForceTarget] = useState<{ id: string; name: string } | null>(null);
    const [forcing, setForcing] = useState(false);
    // Device being renamed; `renameValue` holds the edited name, `renaming` the in-flight save.
    const [renameTarget, setRenameTarget] = useState<{ id: string; name: string } | null>(null);
    const [renameValue, setRenameValue] = useState('');
    const [renaming, setRenaming] = useState(false);
    // Validity preset for newly generated codes ('custom' / 'none' are special).
    const [ttlPreset, setTtlPreset] = useState<string>('300');
    const [customMinutes, setCustomMinutes] = useState<string>('30');
    // Whether a newly generated code auto-approves the device on enrollment.
    const [autoApprove, setAutoApprove] = useState(false);

    const fetchCodes = async (): Promise<LinkCodeResponse[]> => {
        try {
            const res = await get('/api/devices/link-codes', linkCodesListResponseSchema);
            setCodes(res.codes);
            return res.codes;
        } catch {
            return [];
        }
    };

    // Resolve the chosen preset to a request payload. Returns `undefined` on an
    // invalid custom value (caller shows an error).
    const resolveTtlSeconds = (): { ttlSeconds: number | null } | undefined => {
        if (ttlPreset === 'none') return { ttlSeconds: null };
        if (ttlPreset === 'custom') {
            const mins = Number(customMinutes);
            if (!Number.isFinite(mins) || mins <= 0) return undefined;
            return { ttlSeconds: Math.min(Math.round(mins * 60), LINK_CODE_TTL_MAX_SECONDS) };
        }
        return { ttlSeconds: Number(ttlPreset) };
    };

    const generateLinkCode = async () => {
        const body = resolveTtlSeconds();
        if (!body) {
            setGenError('Durée personnalisée invalide.');
            return;
        }
        setGeneratingCode(true);
        setGenError(null);
        try {
            await post('/api/devices/link', { ...body, autoApprove }, linkCodeResponseSchema);
            await fetchCodes();
        } catch {
            setGenError('Impossible de générer un code de liaison. Réessayez.');
        } finally {
            setGeneratingCode(false);
        }
    };

    const deleteCode = async (code: string) => {
        // Optimistic: drop it locally, reconcile via fetch on failure.
        setCodes((prev) => prev.filter((c) => c.code !== code));
        try {
            await del(`/api/devices/link-codes/${encodeURIComponent(code)}`);
        } catch {
            await fetchCodes();
        }
    };

    // Toggle auto-approval on an existing code (edited straight from the table).
    const toggleAutoApprove = async (code: string, value: boolean) => {
        // Optimistic: reflect it immediately, reconcile via fetch on failure.
        setCodes((prev) => prev.map((c) => (c.code === code ? { ...c, autoApprove: value } : c)));
        try {
            await patch(`/api/devices/link-codes/${encodeURIComponent(code)}`, { autoApprove: value });
        } catch {
            await fetchCodes();
        }
    };

    // Manual generation only: open the dialog and show the current codes table.
    const openLinkModal = async () => {
        setActionError(null);
        setGenError(null);
        setCopiedCode(null);
        setAutoApprove(false);
        setShowLinkModal(true);
        await fetchCodes();
    };

    const showLinkInfo = () => void openInfo({ title: 'Lier un appareil', body: <LinkInfo />, width: 460 });

    // While the dialog is open, refresh the codes periodically so one consumed by
    // a device enrolling in the background drops out of the table on its own.
    useEffect(() => {
        if (!showLinkModal) return;
        const timer = setInterval(() => void fetchCodes(), 4000);
        return () => clearInterval(timer);
    }, [showLinkModal]);

    // Managed deletion: ask the agent to self-destruct, then archive (keeping the
    // monitoring history). Confirmed via the explanatory dialog below.
    const confirmRemoveDevice = async () => {
        if (!deleteTarget) return;
        setActionError(null);
        setDeleting(true);
        try {
            await ws.send('device.requestDelete', { deviceId: deleteTarget.id });
            setDeleteTarget(null);
            await refresh();
        } catch {
            setActionError('Suppression impossible.');
            void refresh();
        } finally {
            setDeleting(false);
        }
    };

    const cancelDeleteDevice = async (id: string) => {
        setActionError(null);
        try {
            await ws.send('device.cancelDelete', { deviceId: id });
            await refresh();
        } catch {
            setActionError('Annulation impossible.');
        }
    };

    // Force the deletion now (archive) without waiting for the agent to self-destruct.
    const confirmForceDelete = async () => {
        if (!forceTarget) return;
        setActionError(null);
        setForcing(true);
        try {
            await ws.send('device.forceDelete', { deviceId: forceTarget.id });
            setForceTarget(null);
            await refresh();
        } catch {
            setActionError('Suppression impossible.');
        } finally {
            setForcing(false);
        }
    };

    const reactivateDevice = async (id: string) => {
        setActionError(null);
        try {
            await ws.send('device.reactivate', { deviceId: id });
            await refresh();
        } catch {
            setActionError('Réactivation impossible.');
        }
    };

    const confirmDevice = async (id: string) => {
        setActionError(null);
        try {
            await ws.send('device.confirm', { deviceId: id });
            await refresh();
        } catch {
            setActionError('Approbation impossible.');
        }
    };

    const revokeDevice = async (id: string) => {
        setActionError(null);
        try {
            await ws.send('device.revoke', { deviceId: id });
            await refresh();
        } catch {
            setActionError('Révocation impossible.');
        }
    };

    const openRename = (id: string, current: string) => {
        setActionError(null);
        setRenameValue(current);
        setRenameTarget({ id, name: current });
    };

    const confirmRename = async () => {
        if (!renameTarget) return;
        const name = renameValue.trim();
        if (!name || name === renameTarget.name) {
            setRenameTarget(null);
            return;
        }
        setRenaming(true);
        setActionError(null);
        try {
            await ws.send('device.rename', { deviceId: renameTarget.id, name });
            setRenameTarget(null);
            await refresh();
        } catch {
            setActionError('Renommage impossible.');
        } finally {
            setRenaming(false);
        }
    };

    const closeModal = () => {
        setShowLinkModal(false);
        // A device may have paired while the dialog was open — reflect it now.
        void refresh();
    };

    const copyCode = async (code: string) => {
        try {
            await navigator.clipboard.writeText(code);
            setCopiedCode(code);
            setTimeout(() => setCopiedCode((c) => (c === code ? null : c)), 1800);
        } catch {
            // clipboard may be unavailable
        }
    };

    // Archived devices are gone from management; they live (read-only) in
    // Monitoring for browsing their frozen history.
    const visibleDevices = devices.filter((d) => d.status !== 'archived');

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <div className={styles.headerText}>
                    <h2 className={styles.title}>Appareils</h2>
                    <p className={styles.subtitle}>Gérez vos agents DevEye</p>
                </div>
                <button className={styles.addBtn} onClick={openLinkModal} disabled={generatingCode}>
                    {generatingCode ? (
                        <span className={styles.spinner} />
                    ) : (
                        <>
                            <span className='icon icon-plus' />
                            Ajouter un appareil
                        </>
                    )}
                </button>
            </div>

            {actionError && <div className={styles.errorBanner}>{actionError}</div>}

            {loading && devices.length === 0 ? (
                <div className={styles.loader}>Chargement…</div>
            ) : error && devices.length === 0 ? (
                <div className={styles.empty}>
                    <span className={styles.emptyIcon}>⚠️</span>
                    <p>{error}</p>
                </div>
            ) : visibleDevices.length === 0 ? (
                <div className={styles.empty}>
                    <span className={styles.emptyIcon}>🖥️</span>
                    <p>Aucun appareil lié</p>
                    <p className={styles.hint}>
                        Cliquez sur &quot;Ajouter un appareil&quot; pour générer un code de liaison.
                    </p>
                </div>
            ) : (
                <div className={styles.deviceGrid}>
                    {/* No entrance/layout animation here: the cards are plain children of
                        the popup so they morph in and out *with* it (the shared-element
                        transition). Only deletions animate, via exit. */}
                    <AnimatePresence initial={false}>
                        {visibleDevices.map((device) => {
                            const pendingDeletion = device.status === 'pending_deletion';
                            return (
                                <motion.div
                                    key={device.id}
                                    className={styles.deviceCard}
                                    exit={{ opacity: 0, scale: 0.96 }}
                                    transition={{ duration: 0.2, ease: 'easeOut' }}
                                >
                                    <div className={styles.deviceHeader}>
                                        <span className={styles.deviceName}>{device.name}</span>
                                        <StatusBadge tone={device.online ? 'online' : 'offline'}>
                                            {device.online ? 'En ligne' : 'Hors ligne'}
                                        </StatusBadge>
                                    </div>

                                    <div className={styles.deviceInfo}>
                                        <div className={styles.infoRow}>
                                            <span className='icon icon-cpu' />
                                            <span>{device.platform}</span>
                                        </div>
                                        <div className={styles.infoRow}>
                                            <span className='icon icon-shield' />
                                            <StatusBadge tone={statusMeta(device.status).tone} dot={false}>
                                                {statusMeta(device.status).label}
                                            </StatusBadge>
                                        </div>
                                        <div className={styles.infoRow}>
                                            <span className='icon icon-clock' />
                                            <span>{device.online ? 'En ligne' : formatLastSeen(device.lastSeen)}</span>
                                        </div>
                                    </div>

                                    {device.deleteError && (
                                        <p className={styles.deleteErrorHint}>
                                            <span className='icon icon-x-circle' /> Échec de la suppression :{' '}
                                            {device.deleteError}
                                        </p>
                                    )}

                                    {pendingDeletion ? (
                                        <p className={styles.pendingHint}>
                                            Suppression demandée. L’agent s’auto-détruira à sa prochaine connexion, puis
                                            l’appareil sera archivé (ses données restent consultables dans Monitoring).
                                        </p>
                                    ) : (
                                        device.status === 'pending' && (
                                            <p className={styles.pendingHint}>
                                                Approuvez cet appareil pour autoriser la collecte de métriques.
                                            </p>
                                        )
                                    )}

                                    {pendingDeletion ? (
                                        <div className={styles.pendingActions}>
                                            <button
                                                className={`${styles.pendingBtn} ${styles.pendingCancel}`}
                                                onClick={() => cancelDeleteDevice(device.id)}
                                            >
                                                <span className='icon icon-x-circle' /> Annuler la suppression
                                            </button>
                                            <button
                                                className={`${styles.pendingBtn} ${styles.pendingForce}`}
                                                onClick={() => setForceTarget({ id: device.id, name: device.name })}
                                            >
                                                <span className='icon icon-trash' /> Supprimer sans attendre
                                            </button>
                                        </div>
                                    ) : (
                                        <div className={styles.deviceActions}>
                                            {device.status === 'pending' && (
                                                <button
                                                    className={`${styles.actionBtn} ${styles.actionPrimary}`}
                                                    onClick={() => confirmDevice(device.id)}
                                                    title='Approuver'
                                                >
                                                    <span className='icon icon-check-circle' /> Approuver
                                                </button>
                                            )}
                                            {device.status === 'revoked' && (
                                                <button
                                                    className={`${styles.actionBtn} ${styles.actionPrimary}`}
                                                    onClick={() => reactivateDevice(device.id)}
                                                    title='Réactiver'
                                                >
                                                    <span className='icon icon-check-circle' /> Réactiver
                                                </button>
                                            )}
                                            <button
                                                className={styles.actionBtn}
                                                onClick={() => openRename(device.id, device.name)}
                                                title='Renommer'
                                            >
                                                <span className='icon icon-edit' />
                                            </button>
                                            {device.status === 'active' && (
                                                <button
                                                    className={`${styles.actionBtn} ${styles.actionDanger}`}
                                                    onClick={() => revokeDevice(device.id)}
                                                    title='Révoquer'
                                                >
                                                    <span className='icon icon-x-circle' />
                                                </button>
                                            )}
                                            <button
                                                className={`${styles.actionBtn} ${styles.actionDanger}`}
                                                onClick={() => setDeleteTarget({ id: device.id, name: device.name })}
                                                title='Supprimer'
                                            >
                                                <span className='icon icon-trash' />
                                            </button>
                                        </div>
                                    )}
                                </motion.div>
                            );
                        })}
                    </AnimatePresence>
                </div>
            )}

            <Dialog
                open={showLinkModal}
                onClose={closeModal}
                title='Codes de liaison'
                description="Générez un code, puis utilisez-le dans l'agent DevEye pour lier un appareil."
                headerAction={
                    <button
                        className={styles.iconBtn}
                        onClick={showLinkInfo}
                        title='Comment lier un appareil ?'
                        aria-label='Aide'
                    >
                        <span className='icon icon-info' />
                    </button>
                }
                footer={
                    <>
                        <Button variant='secondary' icon='cpu' onClick={() => setShowDownloadModal(true)}>
                            Télécharger l’agent
                        </Button>
                        <Button variant='secondary' onClick={closeModal}>
                            Fermer
                        </Button>
                    </>
                }
            >
                {/* Generation controls: pick a validity, then generate. */}
                <div className={styles.genRow}>
                    <SelectInput
                        value={ttlPreset}
                        onChange={(e) => setTtlPreset(e.target.value)}
                        aria-label='Durée de validité'
                    >
                        <option value='300'>Valide 5 minutes</option>
                        <option value='900'>Valide 15 minutes</option>
                        <option value='3600'>Valide 1 heure</option>
                        <option value='86400'>Valide 24 heures</option>
                        <option value='custom'>Durée personnalisée…</option>
                        <option value='none'>Sans expiration</option>
                    </SelectInput>
                    {ttlPreset === 'custom' && (
                        <TextInput
                            type='number'
                            min='1'
                            value={customMinutes}
                            onChange={(e) => setCustomMinutes(e.target.value)}
                            className={styles.minutesInput}
                            aria-label='Durée en minutes'
                            placeholder='minutes'
                        />
                    )}
                    <Button onClick={generateLinkCode} disabled={generatingCode}>
                        {generatingCode ? 'Génération…' : 'Générer'}
                    </Button>
                </div>
                <Switch
                    checked={autoApprove}
                    onChange={setAutoApprove}
                    label='Approuver automatiquement à la liaison'
                    hint='Sinon l’appareil reste « En attente » jusqu’à votre approbation (recommandé).'
                />
                {genError && <p className={styles.genError}>{genError}</p>}

                {/* Table of active (pending) codes. */}
                {codes.length === 0 ? (
                    <p className={styles.noCodes}>Aucun code actif. Générez-en un ci-dessus.</p>
                ) : (
                    <table className={styles.codeTable}>
                        <thead>
                            <tr>
                                <th>Code</th>
                                <th>Validité</th>
                                <th aria-label='Actions' />
                            </tr>
                        </thead>
                        <tbody>
                            {codes.map((c) => (
                                <tr key={c.code}>
                                    <td>
                                        <code className={styles.codeCell}>{c.code}</code>
                                    </td>
                                    <td className={styles.validityCell}>{formatExpiry(c.expiresAt)}</td>
                                    <td className={styles.codeRowActions}>
                                        <button
                                            className={`${styles.iconBtn} ${c.autoApprove ? styles.iconApprove : ''}`}
                                            onClick={() => toggleAutoApprove(c.code, !c.autoApprove)}
                                            aria-pressed={c.autoApprove}
                                            title={
                                                c.autoApprove
                                                    ? 'Auto-approbation activée — cliquer pour désactiver'
                                                    : 'Auto-approbation désactivée — cliquer pour activer'
                                            }
                                        >
                                            <span
                                                className={`icon ${c.autoApprove ? 'icon-check-circle' : 'icon-x-circle'}`}
                                            />
                                        </button>
                                        <button
                                            className={`${styles.iconBtn} ${copiedCode === c.code ? styles.copied : ''}`}
                                            onClick={() => copyCode(c.code)}
                                            title={copiedCode === c.code ? 'Copié' : 'Copier'}
                                        >
                                            <span
                                                className={`icon ${copiedCode === c.code ? 'icon-check-circle' : 'icon-copy'}`}
                                            />
                                        </button>
                                        <button
                                            className={`${styles.iconBtn} ${styles.iconDanger}`}
                                            onClick={() => deleteCode(c.code)}
                                            title='Invalider ce code'
                                        >
                                            <span className='icon icon-trash' />
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </Dialog>

            <Dialog
                open={deleteTarget !== null}
                onClose={() => setDeleteTarget(null)}
                title={deleteTarget ? `Supprimer « ${deleteTarget.name} » ?` : 'Supprimer'}
                description='La suppression de l’appareil entraînera la destruction définitive de l’agent.'
                footer={
                    <>
                        <Button variant='secondary' onClick={() => setDeleteTarget(null)} disabled={deleting}>
                            Annuler
                        </Button>
                        <Button variant='danger' onClick={confirmRemoveDevice} disabled={deleting}>
                            {deleting ? 'Suppression…' : 'Supprimer l’appareil'}
                        </Button>
                    </>
                }
            >
                <p className={styles.deleteExplainNote}>
                    En cas d’échec de l’auto-destruction, la suppression est interrompue et l’erreur s’affiche sur la
                    carte de l’appareil.
                </p>
            </Dialog>

            <Dialog
                open={renameTarget !== null}
                onClose={() => setRenameTarget(null)}
                title='Renommer l’appareil'
                description={renameTarget ? `Choisissez un nouveau nom pour « ${renameTarget.name} ».` : 'Renommer'}
                width={420}
                footer={
                    <>
                        <Button variant='secondary' onClick={() => setRenameTarget(null)} disabled={renaming}>
                            Annuler
                        </Button>
                        <Button
                            onClick={confirmRename}
                            disabled={
                                renaming || renameValue.trim() === '' || renameValue.trim() === renameTarget?.name
                            }
                        >
                            {renaming ? 'Renommage…' : 'Renommer'}
                        </Button>
                    </>
                }
            >
                <TextInput
                    autoFocus
                    value={renameValue}
                    maxLength={128}
                    placeholder='Nom de l’appareil'
                    aria-label='Nouveau nom de l’appareil'
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') void confirmRename();
                    }}
                />
            </Dialog>

            <Dialog
                open={forceTarget !== null}
                onClose={() => setForceTarget(null)}
                title={forceTarget ? `Supprimer « ${forceTarget.name} » sans attendre ?` : 'Supprimer'}
                description='L’appareil sera archivé immédiatement, sans attendre la reconnexion de l’agent.'
                footer={
                    <>
                        <Button variant='secondary' onClick={() => setForceTarget(null)} disabled={forcing}>
                            Annuler
                        </Button>
                        <Button variant='danger' onClick={confirmForceDelete} disabled={forcing}>
                            {forcing ? 'Suppression…' : 'Supprimer sans attendre'}
                        </Button>
                    </>
                }
            >
                <p className={styles.deleteExplainNote}>
                    L’agent ne sera pas auto-détruit. À utiliser s’il n’existe plus, ou si peu importe qu’il se nettoie.
                    Ses données restent consultables dans Monitoring.
                </p>
            </Dialog>

            <DownloadAgent open={showDownloadModal} onClose={() => setShowDownloadModal(false)} />
        </div>
    );
}
