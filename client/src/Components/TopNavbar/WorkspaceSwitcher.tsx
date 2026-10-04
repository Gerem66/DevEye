import { Fragment } from 'react';
import type React from 'react';
import type { Workspace } from '@deveye/types';
import { motion, AnimatePresence } from 'framer-motion';
import { useRemoteInstances, useRemotePing, type RemoteEntry } from '@/stores/remoteInstances';
import { useLocalUser } from '@/stores/currentUser';
import { isShutOutByPlan, useWorkspaceState } from '@/stores/workspace';
import styles from './TopNavbar.module.css';

/** Le dépli des actions de l'espace quand la bascule change d'espace courant. */
const REVEAL = { duration: 0.2, ease: [0.22, 1, 0.36, 1] } as const;

export interface WorkspaceSwitcherProps {
    /** Bascule vers un autre espace (recharge la session). `instanceId` : l'instance distante qui le porte. */
    onSelect: (workspaceId: number, instanceId: number | null) => void;
    /** Ouvre la connexion à une instance distante, pour rejoindre ensuite `workspaceId` s'il est donné. */
    onConnectRemote: (instanceId: number, workspaceId?: number) => void;
    /** Ferme la session ouverte sur une instance distante. */
    onLogoutRemote: (instanceId: number) => void;
    /** Retire une instance distante de la liste du compte. */
    onRemoveRemote: (instanceId: number) => void;
    /** Ouvre la création d'un espace. */
    onCreate: () => void;
    /** Ouvre l'apparence de l'espace courant. Absent = pas le droit. */
    onAppearance?: () => void;
    /** Passe l'accueil de l'espace courant en organisation, ou l'en sort. Absent = pas le droit. */
    onOrganize?: () => void;
    /** L'accueil est en organisation : l'entrée la valide au lieu de l'ouvrir. */
    organizing?: boolean;
    /** Ouvre la page de gestion de l'espace courant. */
    onManage: (e: React.MouseEvent) => void;
}

const members = (n: number): string => `${n} membre${n > 1 ? 's' : ''}`;

/** Pourquoi une instance ne peut pas servir maintenant, en deux mots ; `null` quand elle le peut. */
function unavailable(entry: RemoteEntry): string | null {
    if (entry.reach === 'offline') return 'Injoignable';
    if (entry.reach === 'closed') return 'Fédération fermée';
    if (entry.reach === 'incompatible') return `Version ${entry.version ?? 'différente'}`;
    return null;
}

/**
 * Section « Espaces » du menu de la topbar : liste plate, visible d'un coup,
 * pour basculer en un clic. L'espace personnel arrive en tête (tri serveur), et
 * tout ce qui agit sur un espace se range sous celui où l'on se trouve. Les
 * espaces des instances distantes viennent toujours en dernier : qu'une
 * instance soit injoignable ne déplace alors rien au-dessus d'elle.
 */
export function WorkspaceSwitcher({
    onSelect,
    onConnectRemote,
    onLogoutRemote,
    onRemoveRemote,
    onCreate,
    onAppearance,
    onOrganize,
    organizing,
    onManage
}: WorkspaceSwitcherProps) {
    const { workspaces, remoteWorkspaces, activeId, activeInstanceId } = useWorkspaceState();
    const remotes = useRemoteInstances();
    const me = useLocalUser();
    // Le menu est ouvert tant que ce composant est monté.
    useRemotePing(true);

    // La gestion est le seul geste réservé aux partagés : le personnel n'a ni
    // membres, ni rôles, et ne se quitte pas.
    const activeList = activeInstanceId === null ? workspaces : (remoteWorkspaces[activeInstanceId] ?? []);
    const manageable = activeList.find((w) => w.id === activeId)?.kind === 'shared';
    const activeRemote = remotes.find((r) => r.instance.id === activeInstanceId);
    const hasActions = Boolean(onAppearance || onOrganize || manageable || activeRemote);

    const actions = (
        <motion.div
            className={styles.workspaceActions}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={REVEAL}
        >
            {onAppearance && (
                <button className={`${styles.menuItem} ${styles.workspaceAction}`} onClick={onAppearance}>
                    <span className='icon icon-appearance' /> Apparence
                </button>
            )}
            {onOrganize && (
                <button className={`${styles.menuItem} ${styles.workspaceAction}`} onClick={onOrganize}>
                    {organizing ? (
                        <>
                            <span className='icon icon-v' /> Valider l’organisation
                        </>
                    ) : (
                        <>
                            <span className='icon icon-edit' /> Organiser l’accueil
                        </>
                    )}
                </button>
            )}
            {manageable && (
                <button className={`${styles.menuItem} ${styles.workspaceAction}`} onClick={onManage}>
                    <span className='icon icon-settings' /> Gérer cet espace
                </button>
            )}
            {activeRemote && (
                <button
                    className={`${styles.menuItem} ${styles.workspaceAction}`}
                    onClick={() => onLogoutRemote(activeRemote.instance.id)}
                >
                    <span className='icon icon-logout' /> Se déconnecter de {activeRemote.instance.label}
                </button>
            )}
        </motion.div>
    );

    /** La rangée d'un espace, d'ici ou d'ailleurs ; `entry` : l'instance distante qui le porte. */
    const row = (w: Workspace, entry: RemoteEntry | null) => {
        const instanceId = entry?.instance.id ?? null;
        const current = w.id === activeId && instanceId === activeInstanceId;
        const blocked = entry
            ? unavailable(entry)
            : isShutOutByPlan(w, me?.id)
              ? 'En pause : au-delà de l’offre du propriétaire'
              : null;
        const shared = w.kind === 'shared' ? `Partagé · ${members(w.users.length)}` : null;
        const meta = entry ? ['Distant', blocked ?? shared ?? entry.instance.label].join(' · ') : (blocked ?? shared);
        return (
            <Fragment key={`${instanceId ?? 'local'}:${w.id}`}>
                <button
                    className={`${styles.menuItem} ${styles.workspaceItem} ${current ? styles.current : ''} ${blocked ? styles.workspaceUnavailable : ''}`}
                    onClick={() => onSelect(w.id, instanceId)}
                    disabled={blocked !== null && !current}
                    aria-current={current ? 'true' : undefined}
                    title={entry ? `${w.name} (${entry.instance.label})` : w.name}
                >
                    <span
                        className={`icon ${entry ? 'icon-server' : w.kind === 'personal' ? 'icon-user-outline' : 'icon-users'}`}
                    />
                    <span className={styles.workspaceText}>
                        <span className={styles.workspaceName}>{w.name}</span>
                        {meta && <span className={styles.workspaceMeta}>{meta}</span>}
                    </span>
                    {current && <span className={`icon icon-v ${styles.workspaceCheck}`} />}
                </button>

                {/* En retrait sous l'espace courant : le décalage dit sur quoi
                    elles agissent, et de la plus courante à la plus rare.
                    `initial={false}` les pose sans animation à l'ouverture du
                    menu, elles ne se déplient qu'en changeant d'espace. */}
                <AnimatePresence initial={false}>{current && hasActions && actions}</AnimatePresence>
            </Fragment>
        );
    };

    /**
     * Une instance où l'on n'a pas de session : ses espaces tels qu'on les a vus
     * la dernière fois, pour que la liste ne change pas de forme, ou l'instance
     * seule si l'on ne s'y est jamais connecté. Tout clic ouvre la connexion.
     */
    const signedOut = (entry: RemoteEntry) => {
        const blocked = unavailable(entry);
        const rows = entry.known.length > 0 ? entry.known : [null];
        return rows.map((known) => (
            <div key={`${entry.instance.id}:${known?.id ?? 'instance'}`} className={styles.remoteRow}>
                <button
                    className={`${styles.menuItem} ${styles.workspaceItem} ${styles.workspaceUnavailable}`}
                    onClick={() => onConnectRemote(entry.instance.id, known?.id)}
                    disabled={blocked !== null}
                    title={`${known?.name ?? entry.instance.label} (${entry.instance.origin})`}
                >
                    <span className='icon icon-server' />
                    <span className={styles.workspaceText}>
                        <span className={styles.workspaceName}>{known?.name ?? entry.instance.label}</span>
                        <span className={styles.workspaceMeta}>Distant · {blocked ?? 'Se connecter'}</span>
                    </span>
                </button>
                <button
                    type='button'
                    className={styles.remoteRemove}
                    onClick={() => onRemoveRemote(entry.instance.id)}
                    title={`Retirer ${entry.instance.label}`}
                    aria-label={`Retirer ${entry.instance.label}`}
                >
                    <span className='icon icon-x' />
                </button>
            </div>
        ));
    };

    return (
        <>
            {/* La création vit sur l'intitulé de la section, pas dans la liste :
                c'est une action sur l'ensemble, pas un espace de plus à choisir. */}
            <div className={styles.menuLabel}>
                <span>Espaces</span>
                <button
                    type='button'
                    className={styles.menuLabelAction}
                    onClick={onCreate}
                    title='Nouvel espace'
                    aria-label='Nouvel espace'
                >
                    <span className='icon icon-plus' />
                </button>
            </div>

            {/* La liste est rendue même à un seul espace, le personnel : c'est la
                ligne d'un espace qui donne son sens au retrait sous elle, et sans
                elle ses actions ne désigneraient plus rien. */}
            {workspaces.map((w) => row(w, null))}
            {remotes.map((entry) =>
                entry.user ? (remoteWorkspaces[entry.instance.id] ?? []).map((w) => row(w, entry)) : signedOut(entry)
            )}

            {/* Le trait ferme la section au lieu de l'ouvrir : elle est en tête de
                menu, un filet au-dessus n'y séparerait rien. */}
            <hr className={styles.divider} />
        </>
    );
}
