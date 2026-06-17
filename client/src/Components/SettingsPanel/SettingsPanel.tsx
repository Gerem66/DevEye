import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTheme, setTheme, ACCENT_PRESETS, BG_PRESETS } from '@/stores/theme';
import styles from './SettingsPanel.module.css';

export interface SettingsPanelProps {
    open: boolean;
    onClose: () => void;
}

const DEFAULT_ACCENT = '#22d3ee';

/** App settings dialog: accent color + dashboard background. */
export default function SettingsPanel({ open, onClose }: SettingsPanelProps) {
    const theme = useTheme();
    const [draftUrl, setDraftUrl] = useState(theme.bgImage ?? '');

    useEffect(() => {
        if (open) setDraftUrl(theme.bgImage ?? '');
    }, [open, theme.bgImage]);

    useEffect(() => {
        if (!open) return;
        const handler = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [open, onClose]);

    const activeAccent = (theme.accent ?? DEFAULT_ACCENT).toLowerCase();
    const applyImage = () => setTheme({ bgImage: draftUrl.trim() || null });
    const customized = Boolean(theme.accent || theme.bgPreset || theme.bgImage);
    const resetAll = () => {
        setDraftUrl('');
        setTheme({ accent: null, bgPreset: null, bgImage: null });
    };

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
                            <span className={styles.sectionLabel}>Couleur d&apos;accent</span>
                            <div className={styles.swatchRow}>
                                {ACCENT_PRESETS.map((p) => (
                                    <button
                                        key={p.key}
                                        type='button'
                                        className={`${styles.swatch} ${activeAccent === p.hex.toLowerCase() ? styles.active : ''}`}
                                        style={{ background: p.hex }}
                                        onClick={() => setTheme({ accent: p.hex })}
                                        title={p.label}
                                        aria-label={p.label}
                                    />
                                ))}
                            </div>
                        </div>

                        <div className={styles.section}>
                            <span className={styles.sectionLabel}>Fond d&apos;écran</span>
                            <div className={styles.bgGrid}>
                                {BG_PRESETS.map((p) => {
                                    const active = !theme.bgImage && (theme.bgPreset ?? 'auto') === p.key;
                                    const preview =
                                        p.css ??
                                        `radial-gradient(120px circle at 28% -10%, var(--accent-glow), transparent 60%), linear-gradient(160deg, #06080f, #0a1622)`;
                                    return (
                                        <button
                                            key={p.key}
                                            type='button'
                                            className={`${styles.bgSwatch} ${active ? styles.active : ''}`}
                                            style={{ background: preview }}
                                            onClick={() =>
                                                setTheme({ bgPreset: p.key === 'auto' ? null : p.key, bgImage: null })
                                            }
                                        >
                                            <span className={styles.bgLabel}>{p.label}</span>
                                        </button>
                                    );
                                })}
                            </div>

                            <p className={styles.sectionHint}>Ou collez l&apos;URL d&apos;une image :</p>
                            <div className={styles.inputRow}>
                                <input
                                    type='url'
                                    className={styles.input}
                                    placeholder='https://exemple.com/image.jpg'
                                    value={draftUrl}
                                    onChange={(e) => setDraftUrl(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') applyImage();
                                    }}
                                />
                                <button className={styles.applyBtn} onClick={applyImage}>
                                    Appliquer
                                </button>
                            </div>
                            {theme.bgImage && <span className={styles.imageActive}>Image active comme fond.</span>}
                        </div>

                        {customized && (
                            <button className={styles.resetBtn} onClick={resetAll}>
                                Réinitialiser
                            </button>
                        )}
                    </motion.div>
                </>
            )}
        </AnimatePresence>
    );
}
