import { type MouseEvent as ReactMouseEvent, type ReactNode, useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import Button from '@/Components/Button';
import { Hint, useHint } from '@/Components/Hint';
import { openInfo } from '@/Components/InfoPopup';
import { useAuth } from '@/auth/AuthProvider';
import { avatarSrc } from '@/Features/Profile/avatar';
import { openAccountView } from '@/stores/accountView';
import { useActiveWorkspace } from '@/stores/workspace';
import { DeploymentStatus } from './DeploymentStatus';
import { ConnectionStatus } from './ConnectionStatus';
import { TopbarWidgets } from './topbarWidgets';
import { EditableTopbarWidgets } from './EditableTopbarWidgets';
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

export type SiteBanner = 'site' | 'priority' | 'env' | 'held';

const BANNER: Record<SiteBanner, { icon: string; title: string; hint: string }> = {
    site: { icon: 'wrench', title: 'Site en maintenance', hint: 'Seuls les administrateurs y ont accès.' },
    priority: {
        icon: 'star',
        title: 'Priorité aux abonnés active',
        hint: 'Tout ce qui tourne pour les comptes gratuits est en pause.'
    },
    env: {
        icon: 'wrench',
        title: 'MAINTENANCE=true est encore posée',
        hint: 'Le prochain redémarrage remettra le site en maintenance.'
    },
    held: {
        icon: 'pause',
        title: 'Forte affluence : priorité aux abonnés',
        hint: 'Ce qui tourne pour votre compte est en pause, rien n’est supprimé, et tout reprendra de soi-même.'
    }
};
const BACK_BTN_SIZE = 34;
/** Le menu s'attarde après une bascule : le temps de couvrir le début du
 *  chargement, et de voir les actions d'espace rejoindre l'espace choisi. */
const MENU_LINGER_MS = 150;

export interface TopNavbarProps {
    /** Optional: current view title (shown when in a feature popup). */
    viewTitle?: string;
    /** Called when user clicks "back to home" in feature mode. */
    onBack?: () => void;
    /** Open the profile feature. Receives the click (Ctrl/Cmd or Shift = force reload). */
    onOpenProfile?: (e: ReactMouseEvent) => void;
    /** Open the security feature. Receives the click (Ctrl/Cmd or Shift = force reload). */
    onOpenSecurity?: (e: ReactMouseEvent) => void;
    /**
     * Les entrées de compte des modules (`manifest.accountEntry`), rangées sous
     * « Sécurité ». `adminTools` : la vue porte aussi des outils d'administration
     * pour celui qui regarde, l'entrée reçoit le bouclier des pages système.
     */
    accountEntries?: readonly { id: string; label: string; icon: string; adminTools?: boolean }[];
    onOpenAccountEntry?: (id: string, e: ReactMouseEvent) => void;
    /** Open the settings panel. Absent = pas le droit de changer l'apparence. */
    onOpenSettings?: () => void;
    /** Enter the home grid organization (edit) mode. Absent = pas le droit. */
    onOrganize?: () => void;
    /** When true, the navbar carries the home-organization banner + a "Terminer"
     *  exit button (replacing the inline edit-mode toolbar). */
    organizing?: boolean;
    /** Leave the home organization mode. */
    onDoneOrganizing?: () => void;
    /** Basculer vers un autre espace de travail. */
    onSelectWorkspace?: (workspaceId: number, instanceId: number | null) => void;
    /** Les trois gestes sur une instance distante : s'y connecter, s'en déconnecter, la retirer. */
    onConnectRemote?: (instanceId: number, workspaceId?: number) => void;
    onLogoutRemote?: (instanceId: number) => void;
    onRemoveRemote?: (instanceId: number) => void;
    /** Ouvrir la création d'un espace. */
    onCreateWorkspace?: () => void;
    /** Les pages système, réservées aux administrateurs : vide pour les autres. */
    adminPages?: readonly { id: string; label: string; icon: string }[];
    /** Le clic porte le modificateur de rechargement forcé. */
    onOpenAdminPage?: (id: string, e: ReactMouseEvent) => void;
    /**
     * Le bandeau de l'accueil. Pour l'administrateur : le site est en
     * maintenance, la priorité aux abonnés est active, ou la maintenance est
     * levée alors que `MAINTENANCE=true` reste posé. Pour un compte que la priorité
     * tient : tout ce qui tourne pour lui est en pause.
     */
    siteBanner?: SiteBanner;
    /** Fermer le rappel de `MAINTENANCE=true`, pour tous les administrateurs. */
    onDismissMaintenanceBanner?: () => void;
    /** Ouvrir la page de gestion de l'espace courant. */
    onManageWorkspace?: (e: React.MouseEvent) => void;
    /**
     * Le corps de la fiche « À propos ». Reçu plutôt qu'importé : la fiche lit
     * le catalogue de l'accueil, un composant partagé qui remonterait vers une
     * page inverserait les couches.
     */
    aboutBody?: ReactNode;
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
    accountEntries,
    onOpenAccountEntry,
    onOpenSettings,
    onOrganize,
    organizing,
    onDoneOrganizing,
    onSelectWorkspace,
    onConnectRemote,
    onLogoutRemote,
    onRemoveRemote,
    onCreateWorkspace,
    onManageWorkspace,
    adminPages,
    onOpenAdminPage,
    siteBanner,
    onDismissMaintenanceBanner,
    aboutBody
}: TopNavbarProps) {
    const { user, logout } = useAuth();
    const workspace = useActiveWorkspace();
    const [menuOpen, setMenuOpen] = useState(false);
    const [lingering, setLingering] = useState(false);
    const menuRef = useRef<HTMLDivElement>(null);

    // Fermeture différée après une bascule. Le minuteur vit dans un effet pour
    // qu'un démontage ou une fermeture par ailleurs l'annule au lieu de venir
    // refermer un menu que l'on vient de rouvrir.
    useEffect(() => {
        if (!lingering) return;
        const timer = setTimeout(() => {
            setMenuOpen(false);
            setLingering(false);
        }, MENU_LINGER_MS);
        return () => clearTimeout(timer);
    }, [lingering]);

    useEffect(() => {
        if (!menuOpen) setLingering(false);
    }, [menuOpen]);

    // Une bascule remet les droits à zéro le temps que le serveur réponde, et
    // inconnu n'est pas refusé : lues telles quelles, ces deux entrées
    // disparaîtraient sous les yeux de qui vient de cliquer. Le menu garde donc
    // celles qu'il montrait au clic jusqu'à sa fermeture.
    const live = { onOpenSettings, onOrganize: organizing ? onDoneOrganizing : onOrganize };
    const shownRef = useRef(live);
    if (!lingering) shownRef.current = live;
    const shown = shownRef.current;

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
    const versionShown = !(inFeature && viewTitle);
    const aboutHint = useHint('aboutHintDismissed', versionShown && !organizing);

    return (
        <nav className={`${styles.navbar} ${inFeature ? styles.blurred : ''} ${organizing ? styles.organizing : ''}`}>
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
                                className={`${styles.version} ${aboutHint.show ? styles.versionHinted : ''}`}
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                                transition={FADE}
                                onClick={() => {
                                    aboutHint.dismiss();
                                    void openInfo({
                                        title: `À propos de DevEye · ${version}`,
                                        body: aboutBody,
                                        width: 760
                                    });
                                }}
                                title='À propos de DevEye'
                            >
                                {version}
                            </motion.button>
                        )}
                    </AnimatePresence>
                    {aboutHint.show && (
                        <Hint
                            title='Quoi de neuf ?'
                            placement='below'
                            className={styles.versionHint}
                            onDismiss={aboutHint.dismiss}
                        >
                            Ce numéro de version ouvre les nouveautés de chaque mise à jour, le tour des fonctionnalités
                            et les documents légaux.
                        </Hint>
                    )}
                </div>
            </div>

            {/* Center: home-organization banner, in the always-sticky navbar so the
                instructions stay reachable while scrolling. Only opacity is
                animated so the CSS centering transform survives. */}
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
                            <span className={styles.organizeBannerHint}>Glissez les tuiles ou les sections.</span>
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
                {!organizing && !viewTitle && siteBanner && (
                    <motion.div
                        key='siteBanner'
                        className={styles.organizeBanner}
                        role='status'
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={FADE}
                    >
                        <span
                            className={`icon icon-${BANNER[siteBanner].icon} ${styles.organizeBannerIcon} ${styles.maintenanceIcon}`}
                        />
                        <span className={styles.organizeBannerText}>
                            <span className={styles.organizeBannerTitle}>{BANNER[siteBanner].title}</span>
                            <span className={styles.organizeBannerHint}>{BANNER[siteBanner].hint}</span>
                        </span>
                        {(siteBanner === 'site' || siteBanner === 'priority') && onOpenAdminPage && (
                            <Button
                                variant='secondary'
                                className={styles.organizeBannerDone}
                                onClick={(e) => onOpenAdminPage('maintenance', e)}
                            >
                                Gérer
                            </Button>
                        )}
                        {siteBanner === 'env' && onDismissMaintenanceBanner && (
                            <Button
                                variant='ghost'
                                icon='x'
                                className={styles.organizeBannerDone}
                                onClick={onDismissMaintenanceBanner}
                                title='Ne plus afficher ce rappel'
                                aria-label='Ne plus afficher ce rappel'
                            />
                        )}
                        {siteBanner === 'held' && (accountEntries?.length ?? 0) > 0 && (
                            <Button className={styles.organizeBannerDone} onClick={() => openAccountView()}>
                                Voir les offres
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
                        <img src={avatarSrc(user.avatar)} alt='' className={styles.avatar} />
                        <span className={styles.identity}>
                            <span className={styles.username}>{user.username}</span>
                            {/* Seuls les espaces partagés se nomment ici : c'est l'ailleurs
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
                            className={`${styles.menu} ${lingering ? styles.menuClosing : ''}`}
                            initial={{ opacity: 0, y: 0 }}
                            animate={{ opacity: 1, y: 8 }}
                            exit={{ opacity: 0, y: 0 }}
                            transition={{ duration: 0.15 }}
                        >
                            {/* Section « Espaces » en tête : elle dit où l'on est, et
                                tout ce qui suit en dépend. */}
                            {onSelectWorkspace && onCreateWorkspace && onManageWorkspace && (
                                <WorkspaceSwitcher
                                    onSelect={(id, instanceId) => {
                                        onSelectWorkspace(id, instanceId);
                                        setLingering(true);
                                    }}
                                    onConnectRemote={(instanceId, workspaceId) => {
                                        onConnectRemote?.(instanceId, workspaceId);
                                        setMenuOpen(false);
                                    }}
                                    onLogoutRemote={(instanceId) => {
                                        onLogoutRemote?.(instanceId);
                                        setMenuOpen(false);
                                    }}
                                    onRemoveRemote={(instanceId) => {
                                        onRemoveRemote?.(instanceId);
                                        setMenuOpen(false);
                                    }}
                                    onCreate={() => {
                                        onCreateWorkspace();
                                        setMenuOpen(false);
                                    }}
                                    onAppearance={
                                        shown.onOpenSettings &&
                                        (() => {
                                            shown.onOpenSettings?.();
                                            setMenuOpen(false);
                                        })
                                    }
                                    organizing={organizing}
                                    onOrganize={
                                        shown.onOrganize &&
                                        (() => {
                                            shown.onOrganize?.();
                                            setMenuOpen(false);
                                        })
                                    }
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
                            {accountEntries?.map((entry) => (
                                <button
                                    key={entry.id}
                                    className={styles.menuItem}
                                    onClick={(e) => {
                                        onOpenAccountEntry?.(entry.id, e);
                                        setMenuOpen(false);
                                    }}
                                >
                                    <span className={`icon icon-${entry.icon}`} /> {entry.label}
                                    {entry.adminTools && (
                                        <span
                                            className={`icon icon-shield ${styles.adminBadge}`}
                                            title='Contient des outils d’administration'
                                            aria-label='Contient des outils d’administration'
                                        />
                                    )}
                                </button>
                            ))}
                            {/* Second separator: groups the system pages apart
                                from the account pages above. */}
                            {adminPages && adminPages.length > 0 && <hr className={styles.divider} />}
                            {adminPages?.map((page) => (
                                <button
                                    key={page.id}
                                    className={styles.menuItem}
                                    onClick={(e) => {
                                        onOpenAdminPage?.(page.id, e);
                                        setMenuOpen(false);
                                    }}
                                >
                                    <span className={`icon icon-${page.icon}`} /> {page.label}
                                    <span
                                        className={`icon icon-shield ${styles.adminBadge}`}
                                        title='Réservé aux administrateurs'
                                        aria-label='Réservé aux administrateurs'
                                    />
                                </button>
                            ))}
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
