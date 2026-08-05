import { type MouseEvent as ReactMouseEvent, useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import Button from '@/Components/Button';
import { openInfo } from '@/Components/InfoPopup';
import { useAuth } from '@/auth/AuthProvider';
import { useActiveWorkspace } from '@/stores/workspace';
import { DeploymentStatus } from './DeploymentStatus';
import { ConnectionStatus } from './ConnectionStatus';
import { TopbarWidgets } from './topbarWidgets';
import { EditableTopbarWidgets } from './EditableTopbarWidgets';
import AboutContent from './AboutContent';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
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
    /** Open the devices page (admins only). Receives the click (Ctrl/Cmd = force reload). */
    onOpenDevices?: (e: ReactMouseEvent) => void;
    /** Open the logs feature (admins only). Click carries the force-reload modifier. */
    onOpenLogs?: (e: ReactMouseEvent) => void;
    /** Open the settings panel. */
    onOpenSettings?: () => void;
    /** Enter the home grid organization (edit) mode. */
    onOrganize?: () => void;
    /** When true, the navbar carries the home-organization banner + a "Terminer"
     *  exit button (replacing the inline edit-mode toolbar). */
    organizing?: boolean;
    /** Leave the home organization mode. */
    onDoneOrganizing?: () => void;
    /** Basculer vers un autre espace de travail. */
    onSelectWorkspace?: (workspaceId: number) => void;
    /** Ouvrir la création d'un espace. */
    onCreateWorkspace?: () => void;
    /** Ouvrir la page d'administration des comptes (admin). */
    onOpenUsers?: (e: ReactMouseEvent) => void;
    /** Ouvrir la page de gestion de l'espace courant. */
    onManageWorkspace?: (e: React.MouseEvent) => void;
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
    onOpenSettings,
    onOrganize,
    organizing,
    onDoneOrganizing,
    onSelectWorkspace,
    onCreateWorkspace,
    onManageWorkspace,
    onOpenUsers
}: TopNavbarProps) {
    const { user, logout } = useAuth();
    const workspace = useActiveWorkspace();
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
                            <motion.button
                                key='version'
                                type='button'
                                className={styles.version}
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                                transition={FADE}
                                onClick={() =>
                                    void openInfo({
                                        title: `À propos de DevEye · ${version}`,
                                        body: <AboutContent />,
                                        width: 560
                                    })
                                }
                                title='À propos de DevEye'
                            >
                                {version}
                            </motion.button>
                        )}
                    </AnimatePresence>
                </div>
            </div>

            {/* Center: home-organization banner. Lives in the (always sticky) navbar
                so the instructions stay reachable while scrolling the edit grid.
                Text + "Terminer" form one centered block; only opacity is animated
                so the CSS centering transform survives. */}
            <AnimatePresence>
                {organizing && (
                    <motion.div
                        key='organizeBanner'
                        className={styles.organizeBanner}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={FADE}
                    >
                        <span className={`icon icon-edit ${styles.organizeBannerIcon}`} />
                        <span className={styles.organizeBannerText}>
                            <span className={styles.organizeBannerTitle}>Organisation de l’accueil</span>
                            <span className={styles.organizeBannerHint}>Glissez les tuiles ou les catégories.</span>
                        </span>
                        {onDoneOrganizing && (
                            <Button
                                variant='primary'
                                icon='check-circle'
                                className={styles.organizeBannerDone}
                                onClick={onDoneOrganizing}
                            >
                                Terminer
                            </Button>
                        )}
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Right section: deployment readiness (only while not ready) + live status + user profile */}
            <div className={styles.right} ref={menuRef}>
                {/* Surfaces a dropped WS connection + a manual reconnect; hidden when
                    the socket is healthy or never connected. */}
                <ConnectionStatus />
                {/* Hidden in the dev server — the agents aren't built there, so the
                    deployment status would load forever. */}
                {!import.meta.env.DEV && <DeploymentStatus />}
                {/* The navbar mini-widgets — edited right here while organizing the
                    home (no detour through the grid), live otherwise. */}
                {organizing ? <EditableTopbarWidgets /> : <TopbarWidgets onOpenSecurity={onOpenSecurity} />}

                {user && (
                    <button className={styles.profileBtn} onClick={() => setMenuOpen((v) => !v)}>
                        {user.avatar ? (
                            <img src={user.avatar} alt='' className={styles.avatar} />
                        ) : (
                            <span className={`icon icon-user ${styles.avatarPlaceholder}`} />
                        )}
                        <span className={styles.identity}>
                            <span className={styles.username}>{user.username}</span>
                            {/* Seuls les espaces partagés se nomment ici : dire « chez soi »
                                à quelqu'un qui y est déjà n'apprend rien, c'est l'ailleurs
                                qui mérite d'être annoncé. */}
                            {workspace?.kind === 'shared' && (
                                <span className={styles.workspaceLabel} title={workspace.name}>
                                    {workspace.name}
                                </span>
                            )}
                        </span>
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
                            {/* Section « Espaces » en tête : elle dit où l'on est, et
                                tout ce qui suit — apparence, accueil, données — en
                                dépend. Un réglage se lit après le contexte auquel il
                                s'applique, pas avant. */}
                            {onSelectWorkspace && onCreateWorkspace && onManageWorkspace && (
                                <WorkspaceSwitcher
                                    onSelect={(id) => {
                                        onSelectWorkspace(id);
                                        setMenuOpen(false);
                                    }}
                                    onCreate={() => {
                                        onCreateWorkspace();
                                        setMenuOpen(false);
                                    }}
                                    onManage={(e) => {
                                        onManageWorkspace(e);
                                        setMenuOpen(false);
                                    }}
                                />
                            )}
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
                            {onOrganize && (
                                <button
                                    className={styles.menuItem}
                                    onClick={() => {
                                        onOrganize();
                                        setMenuOpen(false);
                                    }}
                                >
                                    <span className='icon icon-edit' /> Organiser l’accueil
                                </button>
                            )}
                            {/* Second separator: groups "fleet" entries (Appareils,
                                Logs) apart from the personal settings above. */}
                            {(onOpenDevices || onOpenLogs || onOpenUsers) && <hr className={styles.divider} />}
                            {onOpenDevices && (
                                <button
                                    className={styles.menuItem}
                                    onClick={(e) => {
                                        onOpenDevices(e);
                                        setMenuOpen(false);
                                    }}
                                >
                                    <span className='icon icon-server' /> Appareils
                                    <span
                                        className={`icon icon-shield ${styles.adminBadge}`}
                                        title='Réservé aux administrateurs'
                                        aria-label='Réservé aux administrateurs'
                                    />
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
                            {onOpenUsers && (
                                <button
                                    className={styles.menuItem}
                                    onClick={(e) => {
                                        onOpenUsers(e);
                                        setMenuOpen(false);
                                    }}
                                >
                                    <span className='icon icon-users' /> Utilisateurs
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
