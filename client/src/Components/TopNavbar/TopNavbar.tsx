import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useAuth } from '@/auth/AuthProvider';
import styles from './TopNavbar.module.css';

import packageJson from '../../../package.json';

const ENV = import.meta.env.VITE_ENV;
const version = packageJson.version + (ENV === 'dev' ? '-dev' : '');

export interface TopNavbarProps {
    /** Optional: current view title (shown when in a feature popup). */
    viewTitle?: string;
    /** Called when user clicks "back to home" in feature mode. */
    onBack?: () => void;
}

/**
 * Top navbar: transparent on home (logo + version left, profile right),
 * slightly blurred when inside a feature (+ back button, feature title).
 */
export default function TopNavbar({ viewTitle, onBack }: TopNavbarProps) {
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
            {/* Left section */}
            <div className={styles.left}>
                {inFeature && onBack && (
                    <button className={styles.backBtn} onClick={onBack} aria-label='Retour au dashboard'>
                        <span className='icon-arrow-left' />
                    </button>
                )}
                <a href='/' className={styles.brand}>
                    <img src='/logo_deveye.png' alt='DevEye' className={styles.logo} />
                    <span className={styles.brandText}>DevEye</span>
                </a>
                <span className={styles.version}>{version}</span>
                {inFeature && viewTitle && <span className={styles.viewTitle}>{viewTitle}</span>}
            </div>

            {/* Right section: user profile */}
            <div className={styles.right} ref={menuRef}>
                {user && (
                    <button className={styles.profileBtn} onClick={() => setMenuOpen((v) => !v)}>
                        {user.avatar ? (
                            <img src={user.avatar} alt='' className={styles.avatar} />
                        ) : (
                            <span className={`icon-user ${styles.avatarPlaceholder}`} />
                        )}
                        <span className={styles.username}>{user.username}</span>
                        <span className={`icon-chevron-down ${styles.chevron} ${menuOpen ? styles.open : ''}`} />
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
                                    /* TODO: open profile */ setMenuOpen(false);
                                }}
                            >
                                <span className='icon-user' /> Profil
                            </button>
                            <button
                                className={styles.menuItem}
                                onClick={() => {
                                    /* TODO: open settings */ setMenuOpen(false);
                                }}
                            >
                                <span className='icon-settings' /> Paramètres
                            </button>
                            <hr className={styles.divider} />
                            <button
                                className={styles.menuItem}
                                onClick={() => {
                                    logout();
                                    setMenuOpen(false);
                                }}
                            >
                                <span className='icon-logout' /> Déconnexion
                            </button>
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>
        </nav>
    );
}
