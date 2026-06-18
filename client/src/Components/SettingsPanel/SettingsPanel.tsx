import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTheme, setTheme, ACCENT_PRESETS, BG_PRESETS, DEFAULT_DIM, DEFAULT_BLUR } from '@/stores/theme';
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
    const [fileError, setFileError] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    // Set while we sync the field *from* theme, so the debounce effect below
    // doesn't treat that programmatic change as a user edit and re-apply it.
    const syncingRef = useRef(false);

    useEffect(() => {
        if (open) {
            const next = theme.bgImage?.startsWith('data:') ? '' : (theme.bgImage ?? '');
            setDraftUrl((prev) => {
                if (prev !== next) syncingRef.current = true;
                return next;
            });
            setFileError(null);
        }
    }, [open, theme.bgImage]);

    // Debounced auto-apply of the URL field: wait 500 ms of inactivity, then
    // commit. No "Appliquer" button needed. The field is empty by nature when a
    // local (data:) image is active, so an empty field must NOT clear it — only
    // a user-typed URL or an explicit reset changes the image from here.
    useEffect(() => {
        if (!open) return;
        if (syncingRef.current) {
            syncingRef.current = false;
            return;
        }
        const url = draftUrl.trim();
        const localImageActive = theme.bgImage?.startsWith('data:') ?? false;
        if (!url && localImageActive) return;
        const t = setTimeout(() => {
            setFileError(null);
            setTheme({ bgImage: url || null });
        }, 500);
        return () => clearTimeout(t);
    }, [draftUrl, open, theme.bgImage]);

    useEffect(() => {
        if (!open) return;
        const handler = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [open, onClose]);

    const activeAccent = (theme.accent ?? DEFAULT_ACCENT).toLowerCase();
    const customized = Boolean(
        theme.accent || theme.bgPreset || theme.bgImage || theme.bgDim !== DEFAULT_DIM || theme.bgBlur !== DEFAULT_BLUR
    );
    const resetAll = () => {
        // Mark a sync only if the field actually changes (else the guard would
        // never be consumed and would swallow the user's next real edit).
        if (draftUrl !== '') syncingRef.current = true;
        setDraftUrl('');
        setFileError(null);
        setTheme({ accent: null, bgPreset: null, bgImage: null, bgDim: DEFAULT_DIM, bgBlur: DEFAULT_BLUR });
    };

    // localStorage caps around ~5 MB; a data-URL inflates ~33%, so keep the
    // source file well under that to leave room for the rest of the theme state.
    const MAX_FILE_BYTES = 3 * 1024 * 1024;
    const pickFile = () => fileInputRef.current?.click();
    const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = ''; // allow re-picking the same file later
        if (!file) return;
        if (!file.type.startsWith('image/')) {
            setFileError('Ce fichier n’est pas une image.');
            return;
        }
        if (file.size > MAX_FILE_BYTES) {
            setFileError('Image trop lourde (max 3 Mo).');
            return;
        }
        const reader = new FileReader();
        reader.onload = () => {
            setFileError(null);
            setDraftUrl('');
            setTheme({ bgImage: typeof reader.result === 'string' ? reader.result : null });
        };
        reader.onerror = () => setFileError('Lecture du fichier impossible.');
        reader.readAsDataURL(file);
    };
    const usingLocalImage = theme.bgImage?.startsWith('data:') ?? false;

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
                        aria-label='Apparence'
                        initial={{ opacity: 0, scale: 0.94, x: '-50%', y: '-50%' }}
                        animate={{ opacity: 1, scale: 1, x: '-50%', y: '-50%' }}
                        exit={{ opacity: 0, scale: 0.94, x: '-50%', y: '-50%' }}
                        transition={{ type: 'spring', stiffness: 320, damping: 30 }}
                    >
                        <div className={styles.header}>
                            <h2 className={styles.title}>
                                <span className='icon icon-appearance' /> Apparence
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

                            <p className={styles.sectionHint}>
                                Ou collez l&apos;URL d&apos;une image, ou choisissez un fichier local :
                            </p>
                            <div className={styles.inputRow}>
                                <input
                                    type='url'
                                    className={styles.input}
                                    placeholder='https://exemple.com/image.jpg'
                                    value={draftUrl}
                                    onChange={(e) => setDraftUrl(e.target.value)}
                                />
                                <input
                                    ref={fileInputRef}
                                    type='file'
                                    accept='image/*'
                                    className={styles.fileInput}
                                    onChange={onFileChange}
                                />
                                <button type='button' className={styles.fileBtn} onClick={pickFile}>
                                    Parcourir…
                                </button>
                            </div>

                            {fileError && <span className={styles.fileError}>{fileError}</span>}
                            {theme.bgImage && (
                                <span className={styles.imageActive}>
                                    {usingLocalImage ? 'Image locale active comme fond.' : 'Image active comme fond.'}
                                </span>
                            )}

                            {theme.bgImage && (
                                <div className={styles.bgTune}>
                                    <div className={styles.sliderRow}>
                                        <span className={styles.sliderLabel}>Assombrir le fond</span>
                                        <input
                                            type='range'
                                            min={0}
                                            max={100}
                                            step={1}
                                            value={theme.bgDim}
                                            className={styles.slider}
                                            onChange={(e) => setTheme({ bgDim: Number(e.target.value) })}
                                        />
                                    </div>
                                    <div className={styles.sliderRow}>
                                        <span className={styles.sliderLabel}>Flouter le fond</span>
                                        <input
                                            type='range'
                                            min={0}
                                            max={100}
                                            step={1}
                                            value={theme.bgBlur}
                                            className={styles.slider}
                                            onChange={(e) => setTheme({ bgBlur: Number(e.target.value) })}
                                        />
                                    </div>
                                </div>
                            )}
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
