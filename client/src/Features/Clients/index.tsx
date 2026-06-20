import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ws } from '@/api/ws';
import { del, get, post } from '@/api/http';
import { StatusBadge, type BadgeTone } from '@/Components/StatusBadge';
import { Dialog } from '@/Components/Dialog';
import Button from '@/Components/Button';
import SelectInput from '@/Components/SelectInput';
import TextInput from '@/Components/TextInput';
import { useDevices, removeDeviceLocal } from '@/stores/devices';
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
    const diffMs = Date.now() - ts;
    const minutes = Math.floor(diffMs / 60000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    if (minutes < 1) return "À l'instant";
    if (minutes < 60) return `Il y a ${minutes} min`;
    if (hours < 24) return `Il y a ${hours}h`;
    return `Il y a ${days}j`;
}

export default function Clients({ user: _user, workspace: _ws }: FeatureProps) {
    const { devices, loading, error, refresh } = useDevices();
    const [codes, setCodes] = useState<LinkCodeResponse[]>([]);
    const [showLinkModal, setShowLinkModal] = useState(false);
    const [generatingCode, setGeneratingCode] = useState(false);
    const [actionError, setActionError] = useState<string | null>(null);
    const [genError, setGenError] = useState<string | null>(null);
    const [copiedCode, setCopiedCode] = useState<string | null>(null);
    // Validity preset for newly generated codes ('custom' / 'none' are special).
    const [ttlPreset, setTtlPreset] = useState<string>('300');
    const [customMinutes, setCustomMinutes] = useState<string>('30');

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
            await post('/api/devices/link', body, linkCodeResponseSchema);
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

    // Manual generation only: open the dialog and show the current codes table.
    const openLinkModal = async () => {
        setActionError(null);
        setGenError(null);
        setCopiedCode(null);
        setShowLinkModal(true);
        await fetchCodes();
    };

    const removeDevice = async (id: string) => {
        setActionError(null);
        try {
            await ws.send('device.delete', { deviceId: id });
            removeDeviceLocal(id);
        } catch {
            setActionError('Suppression impossible.');
            void refresh();
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

    const renameDevice = async (id: string, current: string) => {
        const name = window.prompt('Nouveau nom de l’appareil :', current)?.trim();
        if (!name || name === current) return;
        setActionError(null);
        try {
            await ws.send('device.rename', { deviceId: id, name });
            await refresh();
        } catch {
            setActionError('Renommage impossible.');
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
            ) : devices.length === 0 ? (
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
                        {devices.map((device) => (
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

                                {device.status === 'pending' && (
                                    <p className={styles.pendingHint}>
                                        Approuvez cet appareil pour autoriser la collecte de métriques.
                                    </p>
                                )}

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
                                    <button
                                        className={styles.actionBtn}
                                        onClick={() => renameDevice(device.id, device.name)}
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
                                        onClick={() => removeDevice(device.id)}
                                        title='Supprimer'
                                    >
                                        <span className='icon icon-trash' />
                                    </button>
                                </div>
                            </motion.div>
                        ))}
                    </AnimatePresence>
                </div>
            )}

            <Dialog
                open={showLinkModal}
                onClose={closeModal}
                title='Codes de liaison'
                description="Générez un code, puis utilisez-le dans l'agent DevEye pour lier un appareil."
                footer={
                    <Button variant='secondary' onClick={closeModal}>
                        Fermer
                    </Button>
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

                <div className={styles.instructions}>
                    <h4>Instructions :</h4>
                    <ol>
                        <li>Installez l&apos;agent DevEye (Linux ou macOS) sur votre appareil</li>
                        <li>
                            Exécutez <code>deveye-agent link &lt;code&gt; --server &lt;url&gt;</code>
                        </li>
                        <li>L&apos;appareil apparaît ici en « En attente » — approuvez-le pour démarrer la collecte</li>
                    </ol>
                </div>
            </Dialog>
        </div>
    );
}
