import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useWallpaper } from '@/stores/wallpaper';
import styles from './SettingsPanel.module.css';

export interface SettingsPanelProps {
    open: boolean;
    onClose: () => void;
}

/** App settings dialog. Currently: optional dashboard wallpaper image. */
export default function SettingsPanel({ open, onClose }: SettingsPanelProps) {
    const { image, setImage } = useWallpaper();
    const [draft, setDraft] = useState(image ?? '');

    // Sync the draft with the active value whenever the dialog opens.
    useEffect(() => {
        if (open) setDraft(image ?? '');
    }, [open, image]);

    // Close on Escape
    useEffect(() => {
        if (!open) return;
        const handler = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [open, onClose]);

    const apply = () => setImage(draft.trim() || null);
    const reset = () => {
        setDraft('');
        setImage(null);
    };

    const previewStyle = draft.trim() ? { backgroundImage: `url("${draft.trim().replace(/"/g, '%22')}")` } : undefined;

    return (
        <AnimatePresence>
            {open && (
                <>
                    <motion.div
                        className={styles.overlay}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.18 }}
                        onClick={onClose}
                    />
                    <motion.div
                        className={styles.modal}
                        role='dialog'
                        aria-modal='true'
                        aria-label='Réglages'
                        initial={{ opacity: 0, scale: 0.94, x: '-50%', y: '-46%' }}
                        animate={{ opacity: 1, scale: 1, x: '-50%', y: '-50%' }}
                        exit={{ opacity: 0, scale: 0.94, x: '-50%', y: '-46%' }}
                        transition={{ type: 'spring', stiffness: 320, damping: 30 }}
                    >
                        <div className={styles.header}>
                            <h2 className={styles.title}>
                                <span className='icon icon-settings' /> Réglages
                            </h2>
                            <button className={styles.closeBtn} onClick={onClose} aria-label='Fermer'>
                                <span className='icon icon-x' />
                            </button>
                        </div>

                        <div className={styles.section}>
                            <span className={styles.sectionLabel}>Fond d&apos;écran</span>
                            <p className={styles.sectionHint}>
                                Laissez vide pour le dégradé par défaut, ou collez l&apos;URL d&apos;une image pour
                                passer en mode photo.
                            </p>

                            <div className={styles.previewRow}>
                                <div className={styles.preview} style={previewStyle}>
                                    <span className={styles.previewLabel}>{draft.trim() ? 'Image' : 'Dégradé'}</span>
                                </div>
                            </div>

                            <div className={styles.inputRow}>
                                <input
                                    type='url'
                                    className={styles.input}
                                    placeholder='https://exemple.com/image.jpg'
                                    value={draft}
                                    onChange={(e) => setDraft(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') apply();
                                    }}
                                />
                                <button className={styles.applyBtn} onClick={apply}>
                                    Appliquer
                                </button>
                            </div>

                            {image && (
                                <button className={styles.resetBtn} onClick={reset}>
                                    Réinitialiser le fond
                                </button>
                            )}
                        </div>
                    </motion.div>
                </>
            )}
        </AnimatePresence>
    );
}
