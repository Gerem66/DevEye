import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ws } from '@/api/ws';
import { post } from '@/api/http';
import { StatusBadge } from '@/Components/StatusBadge';
import { useDevices, removeDeviceLocal } from '@/stores/devices';
import { linkCodeResponseSchema, type LinkCodeResponse } from 'deveye-types';
import type { FeatureProps } from '../types';
import styles from './Clients.module.css';

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

export function ClientsWidget() {
    const { devices } = useDevices();
    const onlineCount = devices.filter((d) => d.online).length;

    return (
        <div className={styles.widgetContent}>
            <div className={styles.stat}>
                <span className={styles.statValue}>{devices.length}</span>
                <span className={styles.statLabel}>appareil{devices.length !== 1 ? 's' : ''}</span>
            </div>
            {devices.length > 0 ? (
                <>
                    <div className={styles.miniList}>
                        {devices.slice(0, 3).map((d) => (
                            <div key={d.id} className={styles.miniItem}>
                                <span className={`${styles.dot} ${d.online ? styles.online : ''}`} />
                                <span className={styles.miniName}>{d.name}</span>
                            </div>
                        ))}
                        {devices.length > 3 && <span className={styles.more}>+{devices.length - 3} autres</span>}
                    </div>
                    <span className={styles.widgetFootnote}>{onlineCount} en ligne</span>
                </>
            ) : (
                <span className={styles.widgetEmpty}>Aucun appareil lié</span>
            )}
        </div>
    );
}

export default function Clients({ user: _user, workspace: _ws }: FeatureProps) {
    const { devices, loading, error, refresh } = useDevices();
    const [linkCode, setLinkCode] = useState<LinkCodeResponse | null>(null);
    const [showLinkModal, setShowLinkModal] = useState(false);
    const [generatingCode, setGeneratingCode] = useState(false);
    const [actionError, setActionError] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);

    const generateLinkCode = async () => {
        setGeneratingCode(true);
        setActionError(null);
        try {
            const res = await post('/api/devices/link', {}, linkCodeResponseSchema);
            setLinkCode(res);
            setCopied(false);
            setShowLinkModal(true);
        } catch {
            setActionError('Impossible de générer un code de liaison. Réessayez.');
        } finally {
            setGeneratingCode(false);
        }
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

    const closeModal = () => {
        setShowLinkModal(false);
        // A device may have paired while the dialog was open — reflect it now.
        void refresh();
    };

    const copyCode = async () => {
        if (!linkCode) return;
        try {
            await navigator.clipboard.writeText(linkCode.code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1800);
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
                <button className={styles.addBtn} onClick={generateLinkCode} disabled={generatingCode}>
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
                    <AnimatePresence mode='popLayout'>
                        {devices.map((device) => (
                            <motion.div
                                key={device.id}
                                className={styles.deviceCard}
                                layout
                                initial={{ opacity: 0, scale: 0.96 }}
                                animate={{ opacity: 1, scale: 1 }}
                                exit={{ opacity: 0, scale: 0.96 }}
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
                                        <span>{device.status}</span>
                                    </div>
                                    <div className={styles.infoRow}>
                                        <span className='icon icon-clock' />
                                        <span>{device.online ? 'En ligne' : formatLastSeen(device.lastSeen)}</span>
                                    </div>
                                </div>

                                <div className={styles.deviceActions}>
                                    <button
                                        className={styles.actionBtn}
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

            <AnimatePresence>
                {showLinkModal && linkCode && (
                    <>
                        <motion.div
                            className={styles.modalOverlay}
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            onClick={closeModal}
                        />
                        <motion.div
                            className={styles.modal}
                            initial={{ opacity: 0, scale: 0.9, y: 20 }}
                            animate={{ opacity: 1, scale: 1, y: 0 }}
                            exit={{ opacity: 0, scale: 0.9, y: 20 }}
                        >
                            <h3 className={styles.modalTitle}>Code de liaison</h3>
                            <p className={styles.modalText}>
                                Utilisez ce code dans l&apos;agent DevEye pour lier un nouvel appareil.
                            </p>
                            <div className={styles.codeDisplay}>
                                <code>{linkCode.code}</code>
                                <button
                                    className={`${styles.copyBtn} ${copied ? styles.copied : ''}`}
                                    onClick={copyCode}
                                    title='Copier'
                                >
                                    <span className={`icon ${copied ? 'icon-success' : 'icon-copy'}`} />
                                </button>
                            </div>
                            <p className={styles.expiry}>
                                Expire le {new Date(linkCode.expiresAt * 1000).toLocaleString('fr-FR')}
                            </p>
                            <div className={styles.instructions}>
                                <h4>Instructions :</h4>
                                <ol>
                                    <li>Installez l&apos;agent DevEye sur votre appareil</li>
                                    <li>
                                        Exécutez <code>deveye link {linkCode.code}</code>
                                    </li>
                                    <li>L&apos;appareil apparaîtra automatiquement ici</li>
                                </ol>
                            </div>
                            <button className={styles.closeBtn} onClick={closeModal}>
                                Fermer
                            </button>
                        </motion.div>
                    </>
                )}
            </AnimatePresence>
        </div>
    );
}
