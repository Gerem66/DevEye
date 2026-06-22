import { type MouseEvent as ReactMouseEvent, useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useAuth } from '@/auth/AuthProvider';
import { useDevices } from '@/stores/devices';
import { useWeather } from '@/stores/weather';
import { wmoIcon } from '@/Features/Weather/wmoIcon';
import { DeploymentStatus } from './DeploymentStatus';
import styles from './TopNavbar.module.css';

const ENV = import.meta.env.VITE_ENV;
const version = __APP_VERSION__ + (ENV === 'dev' ? '-dev' : '');

/** Ease-out used for entering elements (fast arrival). */
const COLLAPSE = { duration: 0.28, ease: [0.22, 1, 0.36, 1] } as const;
/** Ease-in used when the back button exits: the button shrinks slowly at first
 *  so the opacity has time to reach zero before the icon gets clipped. */
const COLLAPSE_EXIT = { duration: 0.22, ease: [0.55, 0, 1, 0.45] } as const;
const FADE = { duration: 0.22, ease: [0.22, 1, 0.36, 1] } as const;
const BACK_BTN_SIZE = 34;

export interface TopNavbarProps {
    /** Optional: current view title (shown when in a feature popup). */
    viewTitle?: string;
    /** Called when user clicks "back to home" in feature mode. */
    onBack?: () => void;
    /** Open the profile feature. Receives the click (Ctrl/Cmd = force reload). */
    onOpenProfile?: (e: ReactMouseEvent) => void;
    /** Open the security feature. Receives the click (Ctrl/Cmd = force reload). */
    onOpenSecurity?: (e: ReactMouseEvent) => void;
    /** Open the devices page. Receives the click (Ctrl/Cmd = force reload). */
    onOpenDevices?: (e: ReactMouseEvent) => void;
    /** Open the logs feature (admins only). Click carries the force-reload modifier. */
    onOpenLogs?: (e: ReactMouseEvent) => void;
    /** Open the settings panel. */
    onOpenSettings?: () => void;
}

/** Always-visible main info: current weather (primary city) + online devices. */
function TopbarStatus() {
    const { devices: allDevices } = useDevices();
    const { report } = useWeather();
    const current = report?.current ?? null;

    // Exclude archived devices (history-only) from the live fleet count.
    const devices = allDevices.filter((d) => d.status !== 'archived');
    const onlineCount = devices.filter((d) => d.online).length;
    if (devices.length === 0 && !current) return null;

    return (
        <div className={styles.status}>
            {current && (
                <span className={styles.statusItem} title={report?.label ?? 'Météo'}>
                    <span className={styles.statusTemp}>
                        {wmoIcon(current.code)} {Math.round(current.temperature)}°
                    </span>
                </span>
            )}
            {devices.length > 0 && (
                <span className={styles.statusItem} title='Appareils en ligne'>
                    <span className={`${styles.statusDot} ${onlineCount > 0 ? styles.live : ''}`} />
                    {onlineCount}/{devices.length}
                </span>
            )}
        </div>
    );
}

/**
 * Top navbar: always on top (above the feature popup) so it keeps providing the
 * main info. Transparent-with-scrim on home, surfaced when a feature is open.
 */
export default function TopNavbar({
    viewTitle,
    onBack,
    onOpenProfile,
    onOpenSecurity,
    onOpenDevices,
    onOpenLogs,
    onOpenSettings
}: TopNavbarProps) {
    const { user, logout } = useAuth();
    const [menuOpen, setMenuOpen] = useState(false);
    const menuRef = useRef<HTMLDivElement>(null);

    // Close menu on outside click
    useEffect(() => {
        if (!menuOpen) return;
        const handler = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
                setMenuOpen(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [menuOpen]);

    const inFeature = Boolean(viewTitle);

    return (
        <nav className={`${styles.navbar} ${inFeature ? styles.blurred : ''}`}>
            {/* Left section — the back button collapses its own width so the brand
                slides smoothly in/out of feature mode (no nested layout jank). */}
            <div className={styles.left}>
                <AnimatePresence initial={false}>
                    {inFeature && onBack && (
                        <motion.button
                            key='back'
                            className={styles.backBtn}
                            onClick={onBack}
                            aria-label='Retour au dashboard'
                            initial={{ width: 0, opacity: 0, marginRight: 0 }}
                            animate={{ width: BACK_BTN_SIZE, opacity: 1, marginRight: 8 }}
                            exit={{ width: 0, opacity: 0, marginRight: 0, transition: COLLAPSE_EXIT }}
                            transition={COLLAPSE}
                        >
                            <span className='icon icon-arrow-left' />
                        </motion.button>
                    )}
                </AnimatePresence>

                <button
                    className={styles.brand}
                    onClick={() => {
                        if (inFeature && onBack) {
                            onBack();
                        } else {
                            window.location.href = '/';
                        }
                    }}
                    aria-label='Accueil DevEye'
                >
                    <img src='/logo_deveye.png' alt='DevEye' className={styles.logo} />
                    <span className={styles.brandText}>DevEye</span>
                </button>

                {/* Version pill on home, feature title once a feature is open —
                    swapped in place with a crossfade. */}
                <div className={styles.metaSlot}>
                    <AnimatePresence initial={false} mode='popLayout'>
                        {inFeature && viewTitle ? (
                            <motion.span
                                key='viewTitle'
                                className={styles.viewTitleWrap}
                                initial={{ opacity: 0, x: -6 }}
                                animate={{ opacity: 1, x: 0 }}
                                exit={{ opacity: 0, x: -6 }}
                                transition={FADE}
                            >
                                <span className={styles.diviserDot} />
                                <span className={styles.viewTitle}>{viewTitle}</span>
                            </motion.span>
                        ) : (
                            <motion.span
                                key='version'
                                className={styles.version}
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                                transition={FADE}
                            >
                                {version}
                            </motion.span>
                        )}
                    </AnimatePresence>
                </div>
            </div>

            {/* Right section: deployment readiness (only while not ready) + live status + user profile */}
            <div className={styles.right} ref={menuRef}>
                <DeploymentStatus />
                <TopbarStatus />

                {user && (
                    <button className={styles.profileBtn} onClick={() => setMenuOpen((v) => !v)}>
                        {user.avatar ? (
                            <img src={user.avatar} alt='' className={styles.avatar} />
                        ) : (
                            <span className={`icon icon-user ${styles.avatarPlaceholder}`} />
                        )}
                        <span className={styles.username}>{user.username}</span>
                        <span className={`icon icon-chevron-down ${styles.chevron} ${menuOpen ? styles.open : ''}`} />
                    </button>
                )}

                <AnimatePresence>
                    {menuOpen && (
                        <motion.div
                            className={styles.menu}
                            initial={{ opacity: 0, y: 0 }}
                            animate={{ opacity: 1, y: 8 }}
                            exit={{ opacity: 0, y: 0 }}
                            transition={{ duration: 0.15 }}
                        >
                            <button
                                className={styles.menuItem}
                                onClick={(e) => {
                                    onOpenProfile?.(e);
                                    setMenuOpen(false);
                                }}
                            >
                                <span className='icon icon-user-outline' /> Profil
                            </button>
                            <button
                                className={styles.menuItem}
                                onClick={(e) => {
                                    onOpenSecurity?.(e);
                                    setMenuOpen(false);
                                }}
                            >
                                <span className='icon icon-shield' /> Sécurité
                            </button>
                            <button
                                className={styles.menuItem}
                                onClick={() => {
                                    onOpenSettings?.();
                                    setMenuOpen(false);
                                }}
                            >
                                <span className='icon icon-appearance' /> Apparence
                            </button>
                            {/* Second separator: groups "fleet" entries (Appareils,
                                Logs) apart from the personal settings above. */}
                            {(onOpenDevices || onOpenLogs) && <hr className={styles.divider} />}
                            {onOpenDevices && (
                                <button
                                    className={styles.menuItem}
                                    onClick={(e) => {
                                        onOpenDevices(e);
                                        setMenuOpen(false);
                                    }}
                                >
                                    <span className='icon icon-server' /> Appareils
                                </button>
                            )}
                            {onOpenLogs && (
                                <button
                                    className={styles.menuItem}
                                    onClick={(e) => {
                                        onOpenLogs(e);
                                        setMenuOpen(false);
                                    }}
                                >
                                    <span className='icon icon-activity' /> Logs
                                    <span
                                        className={`icon icon-shield ${styles.adminBadge}`}
                                        title='Réservé aux administrateurs'
                                        aria-label='Réservé aux administrateurs'
                                    />
                                </button>
                            )}
                            <hr className={styles.divider} />
                            <button
                                className={`${styles.menuItem} ${styles.danger}`}
                                onClick={() => {
                                    logout();
                                    setMenuOpen(false);
                                }}
                            >
                                <span className='icon icon-logout' /> Déconnexion
                            </button>
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>
        </nav>
    );
}
