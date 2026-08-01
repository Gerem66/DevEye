import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';

import styles from './style.module.css';
import {
    DEFAULT_GENERATOR_OPTIONS,
    GENERATOR_LENGTH_MAX,
    GENERATOR_LENGTH_MIN,
    generatePassword,
    hasSelectedCharset,
    type PasswordGeneratorOptions
} from './passwordGenerator';

interface CharsetToggle {
    key: keyof Omit<PasswordGeneratorOptions, 'length'>;
    label: string;
}

const CHARSET_TOGGLES: CharsetToggle[] = [
    { key: 'uppercase', label: 'Majuscules (A-Z)' },
    { key: 'lowercase', label: 'Minuscules (a-z)' },
    { key: 'digits', label: 'Chiffres (0-9)' },
    { key: 'symbols', label: 'Symboles (!@#…)' }
];

interface PasswordGeneratorMenuProps {
    /** Called with the freshly generated password to fill the form field. */
    onGenerate: (password: string) => void;
}

/** Anchor for the portaled menu, in viewport coordinates (position: fixed). */
interface MenuAnchor {
    top: number;
    right: number;
}

/**
 * Discreet "generate password" trigger + settings popover (length, character
 * types). Rendered through a portal to <body> — like {@link Dialog} — so it
 * escapes the add/edit dialog's own scroll container and floats above it
 * instead of being clipped or forcing the dialog to scroll to reveal it.
 */
function PasswordGeneratorMenu({ onGenerate }: PasswordGeneratorMenuProps) {
    const [open, setOpen] = useState(false);
    const [options, setOptions] = useState<PasswordGeneratorOptions>(DEFAULT_GENERATOR_OPTIONS);
    const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);

    // Track the trigger's viewport position while open, so the portaled menu
    // stays anchored to it across window resizes and scrolling of any
    // ancestor (capture:true also catches scroll on the dialog's own body).
    useEffect(() => {
        if (!open) return;
        const updateAnchor = () => {
            const rect = triggerRef.current?.getBoundingClientRect();
            if (!rect) return;
            setAnchor({ top: rect.bottom + 8, right: window.innerWidth - rect.right });
        };
        updateAnchor();
        window.addEventListener('resize', updateAnchor);
        window.addEventListener('scroll', updateAnchor, true);
        return () => {
            window.removeEventListener('resize', updateAnchor);
            window.removeEventListener('scroll', updateAnchor, true);
        };
    }, [open]);

    useEffect(() => {
        if (!open) return;
        const handler = (e: MouseEvent) => {
            const target = e.target as Node;
            if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
            setOpen(false);
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [open]);

    const canGenerate = hasSelectedCharset(options);

    function toggleCharset(key: CharsetToggle['key']) {
        setOptions((o) => ({ ...o, [key]: !o[key] }));
    }

    function handleGenerate() {
        if (!canGenerate) return;
        onGenerate(generatePassword(options));
    }

    return (
        <div className={styles.generatorWrap}>
            <button
                ref={triggerRef}
                type='button'
                className={`${styles.generatorTrigger} ${open ? styles.active : ''}`}
                onClick={() => setOpen((v) => !v)}
                title='Générer un mot de passe aléatoire'
                aria-label='Générer un mot de passe aléatoire'
            >
                <span className='icon icon-refresh' />
            </button>

            {createPortal(
                <AnimatePresence>
                    {open && anchor && (
                        <motion.div
                            ref={menuRef}
                            className={styles.generatorMenu}
                            style={{ top: anchor.top, right: anchor.right }}
                            initial={{ opacity: 0, y: 0 }}
                            animate={{ opacity: 1, y: 8 }}
                            exit={{ opacity: 0, y: 0 }}
                            transition={{ duration: 0.15 }}
                        >
                            <div className={styles.generatorLengthRow}>
                                <span className={styles.generatorLengthLabel}>
                                    Longueur
                                    <span className={styles.generatorLengthValue}>{options.length}</span>
                                </span>
                                <input
                                    type='range'
                                    min={GENERATOR_LENGTH_MIN}
                                    max={GENERATOR_LENGTH_MAX}
                                    step={1}
                                    value={options.length}
                                    className={styles.generatorSlider}
                                    onChange={(e) => setOptions((o) => ({ ...o, length: Number(e.target.value) }))}
                                />
                            </div>

                            <div className={styles.generatorOptions}>
                                {CHARSET_TOGGLES.map(({ key, label }) => (
                                    <label key={key} className={styles.generatorOption}>
                                        <input
                                            type='checkbox'
                                            checked={options[key]}
                                            onChange={() => toggleCharset(key)}
                                        />
                                        {label}
                                    </label>
                                ))}
                            </div>

                            {!canGenerate && (
                                <span className={styles.generatorWarning}>
                                    Sélectionnez au moins un type de caractère
                                </span>
                            )}

                            <button
                                type='button'
                                className={styles.generatorGenerateBtn}
                                onClick={handleGenerate}
                                disabled={!canGenerate}
                            >
                                <span className='icon icon-refresh' />
                                Générer
                            </button>
                        </motion.div>
                    )}
                </AnimatePresence>,
                document.body
            )}
        </div>
    );
}

export default PasswordGeneratorMenu;
