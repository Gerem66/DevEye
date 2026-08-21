import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useDismissLayer } from '@/Components/Dialog';
import {
    useTheme,
    setTheme,
    saveBackground,
    clearBackgroundSlot,
    ACCENT_PRESETS,
    BG_PRESETS,
    DEFAULT_DIM,
    DEFAULT_BLUR,
    THEME_SLOT_COUNT
} from '@/stores/theme';
import { fileToBackgroundDataUrl, resolveBackgroundFromUrl } from './appearance';
import styles from './SettingsPanel.module.css';

export interface SettingsPanelProps {
    open: boolean;
    onClose: () => void;
}

const DEFAULT_ACCENT = '#22d3ee';

/** App settings dialog: accent color + dashboard background gallery. */
export default function SettingsPanel({ open, onClose }: SettingsPanelProps) {
    const theme = useTheme();
    const [draftUrl, setDraftUrl] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // Reset transient UI whenever the dialog (re)opens.
    useEffect(() => {
        if (!open) return;
        setDraftUrl('');
        setError(null);
        setNotice(null);
    }, [open]);

    useDismissLayer(open, onClose);

    const activeAccent = (theme.accent ?? DEFAULT_ACCENT).toLowerCase();
    const customized = Boolean(
        theme.accent ||
        theme.bgPreset ||
        theme.bgImage ||
        theme.bgImages.some(Boolean) ||
        theme.bgDim !== DEFAULT_DIM ||
        theme.bgBlur !== DEFAULT_BLUR
    );
    const showGallery = theme.bgImage !== null || theme.bgImages.some(Boolean);

    const resetAll = () => {
        setDraftUrl('');
        setError(null);
        setNotice(null);
        setTheme({
            accent: null,
            bgPreset: null,
            bgImage: null,
            bgImages: Array<string | null>(THEME_SLOT_COUNT).fill(null),
            bgDim: DEFAULT_DIM,
            bgBlur: DEFAULT_BLUR
        });
    };

    // Report what happened after a background was added: an "overflow" warning
    // when no slot was free, or a heads-up when only a raw URL could be kept.
    const announce = (saved: boolean, copied: boolean) => {
        if (!saved) {
            setNotice(
                'Tous les emplacements sont pleins : ce fond est appliqué mais ne sera pas conservé. ' +
                    'Videz un emplacement pour le garder.'
            );
        } else if (!copied) {
            setNotice('Fond ajouté via un lien direct : il dépend de la source (copie impossible).');
        } else {
            setNotice(null);
        }
    };

    const addFromUrl = async () => {
        const url = draftUrl.trim();
        if (!url || busy) return;
        setBusy(true);
        setError(null);
        setNotice(null);
        try {
            const { value, copied } = await resolveBackgroundFromUrl(url);
            const { saved } = saveBackground(value);
            setDraftUrl('');
            announce(saved, copied);
        } catch (e) {
            setError(e instanceof Error ? e.message : "Impossible d'ajouter cette image.");
        } finally {
            setBusy(false);
        }
    };

    const pickFile = () => fileInputRef.current?.click();
    const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = ''; // allow re-picking the same file later
        if (!file || busy) return;
        setBusy(true);
        setError(null);
        setNotice(null);
        try {
            const value = await fileToBackgroundDataUrl(file);
            const { saved } = saveBackground(value);
            announce(saved, true);
        } catch (e) {
            setError(e instanceof Error ? e.message : "Impossible d'ajouter cette image.");
        } finally {
            setBusy(false);
        }
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
                    {/* Le centrage (`translate(-50%, -50%)`) vit sur un cadre
                        STATIQUE, hors de framer : le panneau lui-même n'anime que
                        translation et fondu, jamais d'échelle. Une échelle animée
                        rastérise le contenu à des tailles fractionnaires et les
                        bordures de 1 px y disparaissent jusqu'au repaint suivant
                        (voir le commentaire du panneau de Dialog). */}
                    <div className={styles.modalPlace}>
                        <motion.div
                            className={styles.modal}
                            role='dialog'
                            aria-modal='true'
                            aria-label='Apparence'
                            initial={{ opacity: 0, y: 14 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: 14 }}
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
                                                    setTheme({
                                                        bgPreset: p.key === 'auto' ? null : p.key,
                                                        bgImage: null
                                                    })
                                                }
                                            >
                                                <span className={styles.bgLabel}>{p.label}</span>
                                            </button>
                                        );
                                    })}
                                </div>

                                <p className={styles.sectionHint}>
                                    Ajoutez un fond depuis une URL ou un fichier local (jusqu&apos;à {THEME_SLOT_COUNT}{' '}
                                    conservés) :
                                </p>
                                <div className={styles.inputRow}>
                                    <input
                                        type='url'
                                        className={styles.input}
                                        placeholder='https://exemple.com/image.jpg'
                                        value={draftUrl}
                                        disabled={busy}
                                        onChange={(e) => setDraftUrl(e.target.value)}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter') {
                                                e.preventDefault();
                                                void addFromUrl();
                                            }
                                        }}
                                    />
                                    <button
                                        type='button'
                                        className={styles.fileBtn}
                                        onClick={() => void addFromUrl()}
                                        disabled={busy || !draftUrl.trim()}
                                    >
                                        Ajouter
                                    </button>
                                </div>
                                <input
                                    ref={fileInputRef}
                                    type='file'
                                    accept='image/*'
                                    className={styles.fileInput}
                                    onChange={onFileChange}
                                />
                                <button type='button' className={styles.fileBtnWide} onClick={pickFile} disabled={busy}>
                                    Parcourir un fichier…
                                </button>

                                {busy && <span className={styles.imageActive}>Traitement de l&apos;image…</span>}
                                {error && <span className={styles.fileError}>{error}</span>}
                                {!busy && notice && <span className={styles.imageActive}>{notice}</span>}

                                {showGallery && (
                                    <div className={styles.gallery}>
                                        {theme.bgImages.map((slot, i) =>
                                            slot ? (
                                                <div
                                                    key={i}
                                                    className={`${styles.slot} ${slot === theme.bgImage ? styles.slotActive : ''}`}
                                                >
                                                    <button
                                                        type='button'
                                                        className={styles.slotPick}
                                                        style={{
                                                            backgroundImage: `url("${slot.replace(/"/g, '%22')}")`
                                                        }}
                                                        onClick={() => setTheme({ bgImage: slot })}
                                                        title='Utiliser ce fond'
                                                        aria-label={`Utiliser le fond ${i + 1}`}
                                                        aria-pressed={slot === theme.bgImage}
                                                    />
                                                    <button
                                                        type='button'
                                                        className={styles.slotDelete}
                                                        onClick={() => clearBackgroundSlot(i)}
                                                        title='Vider cet emplacement'
                                                        aria-label={`Vider l'emplacement ${i + 1}`}
                                                    >
                                                        <span className='icon icon-x' />
                                                    </button>
                                                </div>
                                            ) : (
                                                <div
                                                    key={i}
                                                    className={`${styles.slot} ${styles.slotEmpty}`}
                                                    aria-hidden='true'
                                                />
                                            )
                                        )}
                                    </div>
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
                    </div>
                </>
            )}
        </AnimatePresence>
    );
}
