import { type MouseEvent as ReactMouseEvent, useEffect, useState } from 'react';

import { getSecrecyWindowMs, lockSecrecyNow, postponeSecrecyFlush, requestUnlock, useSecrecy } from '@/stores/secrecy';
import styles from './SecrecyTimer.module.css';

/** Human-readable remaining time, e.g. "2 min" or "45 s". */
function formatRemaining(ms: number): string {
    const seconds = Math.ceil(ms / 1000);
    if (seconds >= 60) return `${Math.ceil(seconds / 60)} min`;
    return `${seconds} s`;
}

/**
 * Topbar mini-widget for password-based encryption, styled like the reconnect
 * pill. Three states:
 *  1. enabled + locked   → a lone padlock; hover reveals "Déverrouiller", click
 *     opens the unlock prompt (so the session can be unlocked ahead of any action).
 *  2. enabled + unlocked → a padlock + a live countdown bar. The remaining time
 *     shows only on hover (no reserved space). Clicking the bar postpones the
 *     flush; clicking the padlock re-locks immediately (flushes the cached DEK).
 *  3. disabled           → a sober open-padlock; click opens the security page.
 *  4. enabled, "always prompt" (interval 0) → caching is pointless, so instead of
 *     a no-op unlock the widget reads as informational and routes to the config.
 */
export function SecrecyTimer({ onOpenSecurity }: { onOpenSecurity?: (e: ReactMouseEvent) => void }) {
    const { enabled, unlocked, unlockedUntil, alwaysPrompt } = useSecrecy();
    const [, setTick] = useState(0);

    // Re-render once a second while a countdown is running so the bar animates
    // down; resync immediately whenever the expiry changes (e.g. after a click).
    const counting = enabled && unlocked && unlockedUntil != null;
    useEffect(() => {
        if (!counting) return;
        setTick((n) => n + 1);
        const t = setInterval(() => setTick((n) => n + 1), 1000);
        return () => clearInterval(t);
    }, [counting, unlockedUntil]);

    // State 3 — feature off: invite to the security page.
    if (!enabled) {
        return (
            <button
                type='button'
                className={`${styles.pill} ${styles.off}`}
                onClick={(e) => onOpenSecurity?.(e)}
                title='Chiffrement par mot de passe désactivé'
                aria-label='Chiffrement par mot de passe désactivé — ouvrir la sécurité'
            >
                <span className={`icon icon-unlock ${styles.icon}`} />
                <span className={styles.hoverLabel}>Configurer</span>
            </button>
        );
    }

    // State 4 — enabled but "validate on every action": unlocking ahead of time
    // would be wiped instantly, so route to the config instead of offering it.
    if (alwaysPrompt) {
        return (
            <button
                type='button'
                className={`${styles.pill} ${styles.always}`}
                onClick={(e) => onOpenSecurity?.(e)}
                title='Mot de passe demandé à chaque action — configurer la durée'
                aria-label='Mot de passe demandé à chaque action — ouvrir la configuration'
            >
                <span className={`icon icon-lock ${styles.icon}`} />
                <span className={styles.hoverLabel}>Systématique</span>
            </button>
        );
    }

    // State 1 — locked: click to unlock.
    if (!unlocked) {
        return (
            <button
                type='button'
                className={`${styles.pill} ${styles.locked}`}
                onClick={() => void requestUnlock().catch(() => {})}
                title='Déverrouiller vos données'
                aria-label='Déverrouiller vos données chiffrées'
            >
                <span className={`icon icon-lock ${styles.icon}`} />
                <span className={styles.hoverLabel}>Déverrouiller</span>
            </button>
        );
    }

    // State 2 — unlocked: padlock (re-lock) + countdown bar (postpone).
    const total = getSecrecyWindowMs();
    // `unlockedUntil == null` while unlocked = a popup hold paused the countdown.
    const paused = unlockedUntil == null;
    // Clamp to [0, total] so display/bar never overshoot the configured window
    // (avoids brief "2 min"/"3 min" flashes from server/hold expiries or lag).
    const remaining = paused ? total : Math.max(0, Math.min(total, unlockedUntil - Date.now()));
    const ratio = total > 0 ? remaining / total : 1;

    return (
        <div className={`${styles.pill} ${styles.unlocked} ${ratio <= 0.25 && !paused ? styles.expiring : ''}`}>
            <button
                type='button'
                className={styles.lockBtn}
                onClick={() => void lockSecrecyNow()}
                title='Re-verrouiller maintenant'
                aria-label='Re-verrouiller le coffre maintenant'
            >
                <span className={`icon icon-unlock ${styles.icon}`} />
            </button>
            <button
                type='button'
                className={styles.barBtn}
                onClick={() => void postponeSecrecyFlush()}
                title='Prolonger le déverrouillage'
                aria-label={
                    paused ? 'Déverrouillé (maintenu)' : `Déverrouillé, expire dans ${formatRemaining(remaining)}`
                }
            >
                <span className={styles.track}>
                    <span className={styles.fill} style={{ transform: `scaleX(${ratio})` }} />
                </span>
                {/* Time revealed on hover only; "∞" while a popup hold keeps it pinned. */}
                <span className={styles.hoverTime}>{paused ? '∞' : formatRemaining(remaining)}</span>
            </button>
        </div>
    );
}

export default SecrecyTimer;
