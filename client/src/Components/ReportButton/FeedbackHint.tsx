import { motion } from 'framer-motion';

import styles from './ReportButton.module.css';

export interface FeedbackHintProps {
    /** Referme la bulle pour de bon (la croix). */
    onDismiss: () => void;
}

/**
 * La bulle qui présente le bouton de signalement aux nouveaux venus : posée
 * juste au-dessus de lui, elle reste tant qu'on ne l'a pas écartée, et le
 * drapeau de compte qui la retire ne se repose jamais (voir `ReportButton`).
 */
export function FeedbackHint({ onDismiss }: FeedbackHintProps) {
    return (
        <motion.aside
            className={styles.hint}
            role='status'
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ type: 'spring', stiffness: 260, damping: 26, delay: 0.6 }}
        >
            <button type='button' className={styles.hintClose} onClick={onDismiss} aria-label='Ne plus afficher'>
                <span className='icon icon-x' />
            </button>
            <p className={styles.hintTitle}>Bienvenue sur DevEye</p>
            <p className={styles.hintBody}>
                La plateforme est toute jeune. Un bug, une idée, une remarque ? Ce bouton nous l’envoie directement.
            </p>
        </motion.aside>
    );
}

export default FeedbackHint;
