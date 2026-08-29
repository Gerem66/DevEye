import { motion, AnimatePresence } from 'framer-motion';
import { ws } from '@/api/ws';
import { useConnectionState } from '@/stores/connection';
import styles from './ConnectionStatus.module.css';

/**
 * Topbar chip shown only when an established WebSocket connection drops;
 * clicking it reconnects (the socket also auto-retries). Gated on
 * `ws.hasConnected`: never flashes during the first connect nor after an
 * intentional close (logout).
 */
export function ConnectionStatus() {
    const state = useConnectionState();
    // `hasConnected` flips alongside the first 'open' state change (which re-renders
    // us via the hook), so reading it outside the store snapshot is safe.
    const reconnecting = ws.hasConnected && state === 'connecting';
    const lost = ws.hasConnected && (state === 'closed' || state === 'error');

    return (
        <AnimatePresence>
            {(lost || reconnecting) && (
                <motion.button
                    type='button'
                    className={styles.pill}
                    onClick={() => void ws.reconnect().catch(() => {})}
                    disabled={reconnecting}
                    title={reconnecting ? 'Reconnexion en cours…' : 'Reconnecter'}
                    aria-label={reconnecting ? 'Reconnexion en cours' : 'Connexion perdue, cliquer pour reconnecter'}
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.9 }}
                    transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                >
                    <span
                        className={`icon ${reconnecting ? `icon-spinner ${styles.spin}` : 'icon-x-circle'} ${styles.statusIcon}`}
                    />
                    <span className={styles.label}>{reconnecting ? 'Reconnexion…' : 'Connexion perdue'}</span>
                    {!reconnecting && (
                        <span className={styles.retry} aria-hidden='true'>
                            <span className={`icon icon-refresh ${styles.retryIcon}`} />
                        </span>
                    )}
                </motion.button>
            )}
        </AnimatePresence>
    );
}
