import { AnimatePresence, motion } from 'framer-motion';
import { useDismissLayer } from 'deveye-sdk-client';
import type { OsintHistoryEntry, OsintTargetKind } from 'deveye-types';

import styles from './Osint.module.css';

/**
 * L'historique, en tiroir depuis la droite.
 *
 * Masqué par défaut : la grille de cartes est ce qu'on vient voir, et une
 * colonne latérale permanente lui prenait de la largeur en dehors des moments
 * où on rouvre une recherche passée.
 *
 * Animations et inscription à la pile Échap reprises de
 * `Components/SettingsPanel` — même ressort, même voile, pour que les deux
 * tiroirs de l'application se comportent exactement pareil.
 */

interface Props {
    open: boolean;
    onClose: () => void;
    entries: OsintHistoryEntry[];
    kindLabels: Record<OsintTargetKind, string>;
    /** Rejoue une entrée : réaffiche ses résultats sans réenregistrer la recherche. */
    onReplay: (entry: OsintHistoryEntry) => void;
    onRemove: (id: string) => void;
    onClear: () => void;
    /** Des entrées sont illisibles faute de déverrouillage. */
    locked: boolean;
    onUnlock: () => void;
}

export function HistoryPanel({
    open,
    onClose,
    entries,
    kindLabels,
    onReplay,
    onRemove,
    onClear,
    locked,
    onUnlock
}: Props): React.ReactElement {
    useDismissLayer(open, onClose);

    return (
        <AnimatePresence>
            {open && (
                <>
                    <motion.div
                        className={styles.panelScrim}
                        onClick={onClose}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.18 }}
                    />
                    <motion.aside
                        className={styles.panel}
                        role='dialog'
                        aria-label='Historique des recherches'
                        initial={{ x: '100%' }}
                        animate={{ x: 0 }}
                        exit={{ x: '100%' }}
                        transition={{ type: 'spring', stiffness: 320, damping: 30 }}
                    >
                        <header className={styles.panelHead}>
                            <h4>Historique</h4>
                            <div className={styles.panelActions}>
                                {entries.length > 0 && (
                                    <button type='button' className={styles.rawToggle} onClick={onClear}>
                                        Tout effacer
                                    </button>
                                )}
                                <button
                                    type='button'
                                    className={styles.iconButton}
                                    onClick={onClose}
                                    aria-label="Fermer l'historique"
                                >
                                    <span className='icon icon-x' aria-hidden />
                                </button>
                            </div>
                        </header>

                        {/* Le déverrouillage n'est jamais forcé à l'ouverture de la
                            feature : sonder un domaine n'a pas à réclamer un mot de
                            passe. On le propose ici, là où il sert vraiment. */}
                        {locked && (
                            <button type='button' className={styles.unlockRow} onClick={onUnlock}>
                                <span className='icon icon-lock' aria-hidden />
                                Déverrouiller pour lire l’historique
                            </button>
                        )}

                        {entries.length === 0 && <p className={styles.muted}>Aucune recherche.</p>}

                        <ul className={styles.historyList}>
                            {entries.map((h) => (
                                <motion.li
                                    key={h.id}
                                    initial={{ opacity: 0, x: 8 }}
                                    animate={{ opacity: 1, x: 0 }}
                                    transition={{ duration: 0.18 }}
                                >
                                    <button
                                        type='button'
                                        className={styles.historyItem}
                                        onClick={() => onReplay(h)}
                                        disabled={!h.query}
                                        title={h.query ?? 'Entrée chiffrée — déverrouillage requis'}
                                    >
                                        <span className={styles.historyKind}>{kindLabels[h.kind]}</span>
                                        <span className={styles.historyQuery}>{h.query ?? '— chiffré —'}</span>
                                    </button>
                                    <button
                                        type='button'
                                        className={styles.historyRemove}
                                        onClick={() => onRemove(h.id)}
                                        aria-label='Supprimer cette entrée'
                                    >
                                        <span className='icon icon-x' aria-hidden />
                                    </button>
                                </motion.li>
                            ))}
                        </ul>
                    </motion.aside>
                </>
            )}
        </AnimatePresence>
    );
}
