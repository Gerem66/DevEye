import { motion, AnimatePresence } from 'framer-motion';
import { useServerStatus } from '@/stores/serverStatus';
import type { BootTask } from 'deveye-types';
import styles from './DeploymentStatus.module.css';

/** The task worth showing: errors first, then the in-flight one. */
function pickPrimary(tasks: BootTask[]): BootTask | null {
    return tasks.find((t) => t.state === 'error') ?? tasks.find((t) => t.state !== 'done') ?? null;
}

/**
 * Discreet topbar zone shown **only while the server isn't 100% ready** — the
 * agent sync (and any future boot step). It surfaces progress and, crucially,
 * errors *before* the related feature is used. Once everything is `done` it
 * disappears for good (the store stops polling too).
 */
export function DeploymentStatus() {
    const status = useServerStatus();
    const visible = status !== null && !status.ready;
    const primary = visible ? pickPrimary(status.tasks) : null;
    const isError = primary?.state === 'error';

    return (
        <AnimatePresence>
            {visible && primary && (
                <motion.div
                    className={`${styles.zone} ${isError ? styles.error : ''}`}
                    initial={{ opacity: 0, width: 0 }}
                    animate={{ opacity: 1, width: 'auto' }}
                    exit={{ opacity: 0, width: 0 }}
                    transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
                    role='status'
                    aria-live='polite'
                    title={primary.error ?? primary.detail ?? primary.label}
                >
                    <span className={`icon ${isError ? 'icon-error' : `icon-spinner ${styles.spin}`} ${styles.icon}`} />
                    {/* Text is hidden during normal progress and revealed on hover
                        (see CSS) — an error keeps it shown. The inner wrapper is the
                        clip surface for the grid reveal animation. */}
                    <span className={styles.text}>
                        <span className={styles.textInner}>
                            <span className={styles.label}>{isError ? 'Problème de déploiement' : primary.label}</span>
                            {(primary.error ?? primary.detail) && (
                                <span className={styles.detail}>{primary.error ?? primary.detail}</span>
                            )}
                        </span>
                    </span>
                    {!isError && primary.progress !== null && (
                        <span className={styles.bar}>
                            <span
                                className={styles.barFill}
                                style={{ width: `${Math.round(primary.progress * 100)}%` }}
                            />
                        </span>
                    )}
                </motion.div>
            )}
        </AnimatePresence>
    );
}
