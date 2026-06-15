import { useCallback, useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ws } from '@/api/ws';
import { post } from '@/api/http';
import { linkCodeResponseSchema, type Device, type LinkCodeResponse } from 'deveye-types';
import type { FeatureProps } from '../types';
import styles from './Clients.module.css';

export function ClientsWidget() {
    const [devices, setDevices] = useState<Device[]>([]);

    useEffect(() => {
        ws.send('device.list', {})
            .then((res) => setDevices(res.devices))
            .catch(() => {});
    }, []);

    return (
        <div className={styles.widgetContent}>
            <div className={styles.stat}>
                <span className={styles.statValue}>{devices.length}</span>
                <span className={styles.statLabel}>appareil{devices.length !== 1 ? 's' : ''}</span>
            </div>
            <div className={styles.miniList}>
                {devices.slice(0, 3).map((d) => (
                    <div key={d.id} className={styles.miniItem}>
                        <span className={`${styles.dot} ${d.online ? styles.online : ''}`} />
                        <span>{d.name}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}

export default function Clients({ user: _user, workspace: _ws }: FeatureProps) {
    const [devices, setDevices] = useState<Device[]>([]);
    const [loading, setLoading] = useState(true);
    const [linkCode, setLinkCode] = useState<LinkCodeResponse | null>(null);
    const [showLinkModal, setShowLinkModal] = useState(false);
    const [generatingCode, setGeneratingCode] = useState(false);

    const fetchDevices = useCallback(async () => {
        try {
            const res = await ws.send('device.list', {});
            setDevices(res.devices);
        } catch {
            // ignore
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void fetchDevices();
    }, [fetchDevices]);

    const generateLinkCode = async () => {
        setGeneratingCode(true);
        try {
            const res = await post('/api/devices/link', {}, linkCodeResponseSchema);
            setLinkCode(res);
            setShowLinkModal(true);
        } catch {
            // ignore
        } finally {
            setGeneratingCode(false);
        }
    };

    const removeDevice = async (id: string) => {
        try {
            await ws.send('device.delete', { deviceId: id });
            setDevices((prev) => prev.filter((d) => d.id !== id));
        } catch {
            // ignore
        }
    };

    const formatLastSeen = (ts: number | null): string => {
        if (ts === null) return 'Jamais';
        const diffMs = Date.now() - ts;
        const minutes = Math.floor(diffMs / 60000);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);
        if (minutes < 1) return "À l'instant";
        if (minutes < 60) return `Il y a ${minutes} min`;
        if (hours < 24) return `Il y a ${hours}h`;
        return `Il y a ${days}j`;
    };

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <div>
                    <h2 className={styles.title}>Appareils</h2>
                    <p className={styles.subtitle}>Gérez vos agents DevEye</p>
                </div>
                <button className={styles.addBtn} onClick={generateLinkCode} disabled={generatingCode}>
                    {generatingCode ? (
                        <span className={styles.spinner} />
                    ) : (
                        <>
                            <span className='icon-plus' />
                            Ajouter un appareil
                        </>
                    )}
                </button>
            </div>

            {loading ? (
                <div className={styles.loader}>Chargement...</div>
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
                    {devices.map((device) => (
                        <motion.div
                            key={device.id}
                            className={styles.deviceCard}
                            layout
                            initial={{ opacity: 0, scale: 0.95 }}
                            animate={{ opacity: 1, scale: 1 }}
                        >
                            <div className={styles.deviceHeader}>
                                <div className={`${styles.statusIndicator} ${device.online ? styles.online : ''}`} />
                                <span className={styles.deviceName}>{device.name}</span>
                            </div>

                            <div className={styles.deviceInfo}>
                                <div className={styles.infoRow}>
                                    <span className='icon-cpu' />
                                    <span>{device.platform}</span>
                                </div>
                                <div className={styles.infoRow}>
                                    <span className='icon-shield' />
                                    <span>{device.status}</span>
                                </div>
                                <div className={styles.infoRow}>
                                    <span className='icon-clock' />
                                    <span>{device.online ? 'En ligne' : formatLastSeen(device.lastSeen)}</span>
                                </div>
                            </div>

                            <div className={styles.deviceActions}>
                                <button
                                    className={styles.actionBtn}
                                    onClick={() => removeDevice(device.id)}
                                    title='Supprimer'
                                >
                                    <span className='icon-trash' />
                                </button>
                            </div>
                        </motion.div>
                    ))}
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
                            onClick={() => setShowLinkModal(false)}
                        />
                        <motion.div
                            className={styles.modal}
                            initial={{ opacity: 0, scale: 0.9, y: 20 }}
                            animate={{ opacity: 1, scale: 1, y: 0 }}
                            exit={{ opacity: 0, scale: 0.9, y: 20 }}
                        >
                            <h3>Code de liaison</h3>
                            <p className={styles.modalText}>
                                Utilisez ce code dans l&apos;agent DevEye pour lier un nouvel appareil.
                            </p>
                            <div className={styles.codeDisplay}>
                                <code>{linkCode.code}</code>
                                <button
                                    className={styles.copyBtn}
                                    onClick={() => navigator.clipboard.writeText(linkCode.code)}
                                >
                                    <span className='icon-copy' />
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
                            <button className={styles.closeBtn} onClick={() => setShowLinkModal(false)}>
                                Fermer
                            </button>
                        </motion.div>
                    </>
                )}
            </AnimatePresence>
        </div>
    );
}
