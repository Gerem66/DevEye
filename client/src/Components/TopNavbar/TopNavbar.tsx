import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useAuth } from '@/auth/AuthProvider';
import { useDevices } from '@/stores/devices';
import { ws } from '@/api/ws';
import { wmoIcon } from '@/Features/Weather/wmoIcon';
import styles from './TopNavbar.module.css';

import packageJson from '../../../package.json';

const ENV = import.meta.env.VITE_ENV;
const version = packageJson.version + (ENV === 'dev' ? '-dev' : '');

export interface TopNavbarProps {
    /** Optional: current view title (shown when in a feature popup). */
    viewTitle?: string;
    /** Called when user clicks "back to home" in feature mode. */
    onBack?: () => void;
    /** Open the profile feature. */
    onOpenProfile?: () => void;
    /** Open the settings panel. */
    onOpenSettings?: () => void;
}

/** Always-visible main info: current weather + online device count. */
function TopbarStatus() {
    const { devices } = useDevices();
    const [weather, setWeather] = useState<{ temp: number; code: number } | null>(null);

    useEffect(() => {
        let cancelled = false;
        const load = async () => {
            try {
                const list = await ws.send('weather.list', {});
                const first = list.locations[0];
                if (!first) {
                    if (!cancelled) setWeather(null);
                    return;
                }
                const res = await ws.send('weather.get', { id: first.id });
                if (!cancelled && res.report?.current) {
                    setWeather({
                        temp: Math.round(res.report.current.temperature),
                        code: res.report.current.code
                    });
                }
            } catch {
                // non-critical
            }
        };
        void load();
        const t = setInterval(load, 10 * 60 * 1000);
        return () => {
            cancelled = true;
            clearInterval(t);
        };
    }, []);

    const onlineCount = devices.filter((d) => d.online).length;
    if (devices.length === 0 && !weather) return null;

    return (
        <div className={styles.status}>
            {weather && (
                <span className={styles.statusItem} title='Météo'>
                    <span className={styles.statusTemp}>
                        {wmoIcon(weather.code)} {weather.temp}°
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
export default function TopNavbar({ viewTitle, onBack, onOpenProfile, onOpenSettings }: TopNavbarProps) {
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
            {/* Left section — entering/leaving a feature animates smoothly */}
            <motion.div layout transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }} className={styles.left}>
                <AnimatePresence initial={false} mode='popLayout'>
                    {inFeature && onBack && (
                        <motion.button
                            key='back'
                            layout
                            className={styles.backBtn}
                            onClick={onBack}
                            aria-label='Retour au dashboard'
                            initial={{ opacity: 0, scale: 0.6 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.6 }}
                            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
                        >
                            <span className='icon icon-arrow-left' />
                        </motion.button>
                    )}
                </AnimatePresence>

                <motion.a
                    layout
                    href='/'
                    className={styles.brand}
                    transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
                >
                    <img src='/logo_deveye.png' alt='DevEye' className={styles.logo} />
                    <span className={styles.brandText}>DevEye</span>
                </motion.a>

                <AnimatePresence initial={false} mode='popLayout'>
                    {inFeature && viewTitle ? (
                        <motion.span
                            key='viewTitle'
                            layout
                            className={styles.viewTitleWrap}
                            initial={{ opacity: 0, x: -6 }}
                            animate={{ opacity: 1, x: 0 }}
                            exit={{ opacity: 0, x: -6 }}
                            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
                        >
                            <span className={styles.diviserDot} />
                            <span className={styles.viewTitle}>{viewTitle}</span>
                        </motion.span>
                    ) : (
                        <motion.span
                            key='version'
                            layout
                            className={styles.version}
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
                        >
                            {version}
                        </motion.span>
                    )}
                </AnimatePresence>
            </motion.div>

            {/* Right section: live status + user profile */}
            <div className={styles.right} ref={menuRef}>
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
                            initial={{ opacity: 0, y: -8 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -8 }}
                            transition={{ duration: 0.15 }}
                        >
                            <button
                                className={styles.menuItem}
                                onClick={() => {
                                    onOpenProfile?.();
                                    setMenuOpen(false);
                                }}
                            >
                                <span className='icon icon-user' /> Profil
                            </button>
                            <button
                                className={styles.menuItem}
                                onClick={() => {
                                    onOpenSettings?.();
                                    setMenuOpen(false);
                                }}
                            >
                                <span className='icon icon-settings' /> Paramètres
                            </button>
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
