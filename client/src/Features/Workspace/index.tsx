import { useEffect, useState } from 'react';

import Button from '@/Components/Button';
import { Dialog } from '@/Components/Dialog';
import SearchSelect from '@/Components/SearchSelect';
import TextInput from '@/Components/TextInput';
import type { WorkspaceRole } from '@deveye/types';
import { useAuth } from '@/auth/AuthProvider';
import { PlanPausedBadge, PlanPausedNotice } from '@/Components/PlanPause';
import { useWorkspacePermissions } from '@/stores/workspace';
import RoleDialog from './RoleDialog';
import Tabs, { type TabDef } from './Tabs';
import { avatarSrc } from '@/Features/Profile/avatar';
import { useWorkspaceAdmin } from './useWorkspaceAdmin';
import styles from './Workspace.module.css';

/** Les vues de la page. « general » existe toujours, les autres dépendent des droits. */
type TabId = 'general' | 'members' | 'roles';

/** Minuit du jour de `date`, en heure locale. */
function dayStart(date: Date): number {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** « 12 oct. » : le jour d'une échéance proche. */
function dayLabel(epoch: number): string {
    return new Date(epoch * 1000).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}

/** « vu il y a 3 j », ou « jamais connecté » pour un compte qui n'est pas encore venu. */
function lastSeen(epoch: number): string {
    if (!epoch) return 'jamais connecté';
    // En jours du calendrier : vu hier soir n'est pas « aujourd'hui » ce matin.
    const days = Math.round((dayStart(new Date()) - dayStart(new Date(epoch * 1000))) / 86_400_000);
    if (days <= 0) return 'vu aujourd’hui';
    if (days === 1) return 'vu hier';
    if (days < 30) return `vu il y a ${days} j`;
    return `vu le ${new Date(epoch * 1000).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

/**
 * Page « Espace de travail » : Général, Membres, Rôles. Les onglets suivent les
 * droits de l'appelant, si bien qu'un onglet affiché mène toujours à quelque
 * chose d'utilisable ; un espace personnel n'en garde qu'un.
 */
export default function FeatureWorkspace() {
    const admin = useWorkspaceAdmin();
    const { refresh } = useAuth();
    const { workspace, isShared, isOwner } = admin;

    const [name, setName] = useState('');
    const [inviteOpen, setInviteOpen] = useState(false);
    const [inviteEmail, setInviteEmail] = useState('');
    const [confirmLeave, setConfirmLeave] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [roleEdited, setRoleEdited] = useState<{ role: WorkspaceRole | null } | null>(null);
    const [tab, setTab] = useState<TabId>('general');

    const { can } = useWorkspacePermissions();
    const canManageMembers = can('workspace.members');
    const canManageRoles = can('workspace.roles');
    const canRename = can('workspace.manage');

    /** Les onglets que les droits de l'appelant rendent utilisables. */
    const tabs: TabDef<TabId>[] = (
        [
            { id: 'general', label: 'Général', icon: 'settings', when: true },
            { id: 'members', label: 'Membres', icon: 'users', badge: workspace?.users.length, when: isShared },
            {
                id: 'roles',
                label: 'Rôles',
                icon: 'shield',
                badge: admin.roles.length,
                when: isShared && canManageRoles
            }
        ] satisfies (TabDef<TabId> & { when: boolean })[]
    )
        .filter((t) => t.when)
        .map(({ when: _when, ...tab }) => tab);

    // Un onglet peut disparaître sous les pieds (droit retiré, espace quitté) :
    // on retombe alors sur « Général », qui existe toujours.
    const active = tabs.some((t) => t.id === tab) ? tab : 'general';

    /** Rôle actuellement porté par un membre. */
    const roleOf = (userId: number): number | null =>
        admin.memberRoles.find((m) => m.userId === userId)?.roleId ?? null;

    useEffect(() => {
        setName(workspace?.name ?? '');
    }, [workspace?.name]);

    if (!workspace) return null;

    const nameChanged = name.trim() !== '' && name.trim() !== workspace.name;

    const submitInvite = (): void => {
        const email = inviteEmail.trim();
        if (email === '') return;
        // Le dialogue ne se ferme qu'en cas de succès : une adresse déjà membre
        // doit rester corrigeable sans tout ressaisir.
        void admin.invite(email).then((ok) => {
            if (ok) {
                setInviteEmail('');
                setInviteOpen(false);
            }
        });
    };

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <div className={styles.headerText}>
                    <h2 className={styles.title}>{workspace.name}</h2>
                    <p className={styles.subtitle}>
                        {isShared
                            ? `Espace partagé · ${workspace.users.length} membre${workspace.users.length > 1 ? 's' : ''}`
                            : 'Votre espace personnel, visible de vous seul'}
                    </p>
                </div>
            </div>

            <Tabs tabs={tabs} active={active} onSelect={setTab} />

            {admin.error && <div className={styles.errorBanner}>{admin.error}</div>}

            <div className={styles.sections}>
                {active === 'general' && (
                    <section className={`${styles.section} ${styles.narrow}`}>
                        <span className={styles.sectionLabel}>Nom</span>
                        <div className={styles.card}>
                            <div className={styles.nameRow}>
                                <TextInput
                                    value={name}
                                    onChange={(e) => setName(e.target.value)}
                                    maxLength={120}
                                    aria-label='Nom de l’espace'
                                    disabled={!canRename}
                                />
                                <Button
                                    onClick={() => void admin.rename(name.trim())}
                                    disabled={!nameChanged || admin.busy || !canRename}
                                >
                                    Renommer
                                </Button>
                            </div>
                            {!canRename && (
                                <p className={styles.hint}>Vous n’avez pas le droit de renommer cet espace.</p>
                            )}
                        </div>
                    </section>
                )}

                {active === 'members' && isShared && (
                    <section className={styles.section}>
                        <div className={styles.sectionHeader}>
                            <span className={styles.sectionLabel}>
                                {workspace.users.length} membre{workspace.users.length > 1 ? 's' : ''}
                            </span>
                            {canManageMembers && (
                                <Button icon='add' onClick={() => setInviteOpen(true)}>
                                    Inviter un membre
                                </Button>
                            )}
                        </div>
                        {workspace.planPaused ? (
                            <PlanPausedNotice count={1} one='espace partagé' many='espaces partagés' />
                        ) : (
                            <PlanPausedNotice count={workspace.pausedMemberIds.length} one='membre' many='membres' />
                        )}
                        {/* `rowList` : le gap de la carte tombe et son padding
                            vertical se resserre, pour que l'air au-dessus de la
                            première ligne (carte + ligne) égale les côtés, et
                            que le trait entre deux lignes soit à mi-chemin. */}
                        <div className={`${styles.card} ${styles.rowList}`}>
                            {workspace.users.map((u) => {
                                const owner = u.id === workspace.ownerUserId;
                                return (
                                    <div key={u.id} className={styles.row}>
                                        <img className={styles.avatar} src={avatarSrc(u.avatar)} alt='' />
                                        <div className={styles.rowText}>
                                            <span className={styles.rowTitle}>
                                                {u.username}{' '}
                                                {owner && <span className={styles.defaultTag}>propriétaire</span>}
                                                {!owner &&
                                                    (workspace.planPaused ||
                                                        workspace.pausedMemberIds.includes(u.id)) && (
                                                        <PlanPausedBadge />
                                                    )}
                                            </span>
                                            <span className={styles.rowMeta}>
                                                {u.email} · {lastSeen(u.lastSeen)}
                                            </span>
                                        </div>
                                        {/* Le propriétaire n'a pas de rôle : il a tout par
                                            construction, et lui en donner un laisserait croire
                                            qu'on peut le lui retirer. */}
                                        {!owner && canManageMembers && (
                                            <SearchSelect
                                                className={styles.memberRole}
                                                value={String(roleOf(u.id) ?? '')}
                                                options={[
                                                    { value: '', label: 'Aucun rôle' },
                                                    ...admin.roles.map((r) => ({ value: String(r.id), label: r.name }))
                                                ]}
                                                onChange={(v) =>
                                                    void admin.assignRole(u.id, v === '' ? null : Number(v))
                                                }
                                                aria-label={`Rôle de ${u.username}`}
                                            />
                                        )}
                                        {isOwner && !owner && (
                                            <button
                                                type='button'
                                                className={`${styles.actionBtn} ${styles.actionDanger}`}
                                                title={`Exclure ${u.username}`}
                                                aria-label={`Exclure ${u.username}`}
                                                onClick={() => void admin.removeMember(u.id)}
                                                disabled={admin.busy}
                                            >
                                                <span className='icon icon-x' />
                                            </button>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </section>
                )}

                {active === 'members' && admin.invitations.length > 0 && (
                    <section className={styles.section}>
                        <div className={styles.sectionHeader}>
                            <span className={styles.sectionLabel}>
                                {admin.invitations.length} invitation{admin.invitations.length > 1 ? 's' : ''} en
                                attente
                            </span>
                        </div>
                        <div className={`${styles.card} ${styles.rowList}`}>
                            {admin.invitations.map((i) => (
                                <div key={i.id} className={styles.row}>
                                    <div className={styles.rowText}>
                                        <span className={styles.rowTitle}>{i.email}</span>
                                        <span className={styles.rowMeta}>expire le {dayLabel(i.expiresAt)}</span>
                                    </div>
                                    <button
                                        type='button'
                                        className={`${styles.actionBtn} ${styles.actionDanger}`}
                                        title={`Annuler l’invitation de ${i.email}`}
                                        aria-label={`Annuler l’invitation de ${i.email}`}
                                        onClick={() => void admin.cancelInvite(i.id)}
                                        disabled={admin.busy}
                                    >
                                        <span className='icon icon-x' />
                                    </button>
                                </div>
                            ))}
                        </div>
                    </section>
                )}

                {active === 'roles' && isShared && canManageRoles && (
                    <section className={styles.section}>
                        <div className={styles.sectionHeader}>
                            <p className={styles.hint}>Un rôle décrit ce qu’un membre peut voir et faire ici.</p>
                            <Button icon='plus' onClick={() => setRoleEdited({ role: null })}>
                                Nouveau rôle
                            </Button>
                        </div>
                        <p className={styles.hint}>Le propriétaire n’en porte jamais : il a tout par construction.</p>
                        {/* Même resserrement que la liste des membres, mais
                            seulement quand il y a des lignes : l'état vide
                            porte sa propre respiration. */}
                        <div className={admin.roles.length === 0 ? styles.card : `${styles.card} ${styles.rowList}`}>
                            {admin.roles.length === 0 ? (
                                // L'onglet vide n'est pas une impasse : un geste pose
                                // deux rôles génériques, à ajuster ensuite si besoin.
                                <div className={styles.emptyBlock}>
                                    <p className={styles.empty}>
                                        Aucun rôle. Sans rôle, un membre invité n’a accès à rien.
                                    </p>
                                    <Button
                                        icon='add'
                                        onClick={() => void admin.createPresetRoles()}
                                        disabled={admin.busy}
                                    >
                                        {admin.busy ? 'Création…' : 'Créer les rôles de départ'}
                                    </Button>
                                    <p className={styles.hint}>
                                        « Admin » peut tout ; « Membre » a toutes les fonctionnalités sans
                                        l’administration, et devient le rôle attribué d’office.
                                    </p>
                                </div>
                            ) : (
                                admin.roles.map((r) => (
                                    <div key={r.id} className={styles.row}>
                                        <span className={styles.roleDot} style={{ background: r.color }} />
                                        <div className={styles.rowText}>
                                            <span className={styles.rowTitle}>
                                                {r.name}{' '}
                                                {r.isDefault && <span className={styles.defaultTag}>par défaut</span>}
                                            </span>
                                            <span className={styles.rowMeta}>
                                                {r.features.length} fonctionnalité(s) · {r.capabilities.length} droit(s)
                                                d’administration · {r.memberCount} membre(s)
                                            </span>
                                        </div>
                                        {r.isDefault ? (
                                            // L'étoile ne disparaît pas, elle se remplit : l'état
                                            // s'affiche là où le geste se fait, et la colonne
                                            // d'actions reste alignée d'une ligne à l'autre.
                                            <span
                                                className={styles.defaultStar}
                                                title='Rôle par défaut : attribué d’office aux nouveaux membres'
                                                aria-label='Rôle par défaut'
                                            >
                                                <span className='icon icon-star' />
                                            </span>
                                        ) : (
                                            <button
                                                type='button'
                                                className={styles.actionBtn}
                                                title='Attribuer d’office aux nouveaux membres'
                                                aria-label='Définir comme rôle par défaut'
                                                onClick={() => void admin.setDefaultRole(r.id)}
                                                disabled={admin.busy}
                                            >
                                                <span className='icon icon-star-outline' />
                                            </button>
                                        )}
                                        <button
                                            type='button'
                                            className={styles.actionBtn}
                                            title='Modifier'
                                            aria-label={`Modifier ${r.name}`}
                                            onClick={() => setRoleEdited({ role: r })}
                                        >
                                            <span className='icon icon-edit' />
                                        </button>
                                        <button
                                            type='button'
                                            className={`${styles.actionBtn} ${styles.actionDanger}`}
                                            title='Supprimer'
                                            aria-label={`Supprimer ${r.name}`}
                                            onClick={() => void admin.deleteRole(r.id)}
                                            disabled={admin.busy}
                                        >
                                            <span className='icon icon-trash' />
                                        </button>
                                    </div>
                                ))
                            )}
                        </div>
                    </section>
                )}

                {/* La zone sensible reste sous « Général » : la reléguer dans un onglet
                    à part la rendrait plus difficile à trouver que ce qu'elle mérite,
                    et un onglet entier pour un bouton serait disproportionné. */}
                {active === 'general' && isShared && (
                    <section className={`${styles.section} ${styles.narrow}`}>
                        <span className={styles.sectionLabel}>Zone sensible</span>
                        <div className={styles.card}>
                            <div className={styles.dangerZone}>
                                <p className={styles.hint}>
                                    {isOwner
                                        ? 'Supprimer l’espace détruit définitivement tout ce qu’il contient, pour tous ses membres.'
                                        : 'Quitter cet espace vous en retire l’accès. Son contenu n’est pas supprimé.'}
                                </p>
                                {isOwner ? (
                                    <Button variant='danger' onClick={() => setConfirmDelete(true)}>
                                        Supprimer l’espace
                                    </Button>
                                ) : (
                                    <Button variant='danger' onClick={() => setConfirmLeave(true)}>
                                        Quitter l’espace
                                    </Button>
                                )}
                            </div>
                        </div>
                    </section>
                )}
            </div>

            <Dialog
                open={inviteOpen}
                onClose={() => setInviteOpen(false)}
                title='Inviter un membre'
                description='La personne retrouve l’invitation dans son menu des espaces et rejoint l’espace en l’acceptant, avec le rôle par défaut. Elle a quatorze jours pour répondre.'
                width={440}
                onSubmit={submitInvite}
                footer={
                    <>
                        <Button variant='secondary' onClick={() => setInviteOpen(false)} disabled={admin.busy}>
                            Annuler
                        </Button>
                        <Button onClick={submitInvite} disabled={admin.busy || inviteEmail.trim() === ''}>
                            {admin.busy ? 'Envoi…' : 'Inviter'}
                        </Button>
                    </>
                }
            >
                <label className={styles.sectionLabel} htmlFor='invite-email'>
                    Adresse email
                </label>
                <TextInput
                    id='invite-email'
                    type='email'
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    maxLength={320}
                    placeholder='personne@exemple.fr'
                    aria-label='Adresse email de la personne à inviter'
                />
            </Dialog>

            <RoleDialog
                open={roleEdited !== null}
                role={roleEdited?.role ?? null}
                busy={admin.busy}
                onClose={() => setRoleEdited(null)}
                onSubmit={(draft) => {
                    const edited = roleEdited?.role;
                    void (edited ? admin.updateRole(edited.id, draft) : admin.createRole(draft));
                    setRoleEdited(null);
                }}
            />

            <Dialog
                open={confirmLeave}
                onClose={() => setConfirmLeave(false)}
                title={`Quitter « ${workspace.name} » ?`}
                description='Vous perdrez l’accès à son contenu. Un membre pourra vous réinviter.'
                onSubmit={() => void admin.leave(() => void refresh())}
                footer={
                    <>
                        <Button variant='secondary' onClick={() => setConfirmLeave(false)}>
                            Annuler
                        </Button>
                        <Button
                            variant='danger'
                            onClick={() => void admin.leave(() => void refresh())}
                            disabled={admin.busy}
                        >
                            {admin.busy ? 'Sortie…' : 'Quitter'}
                        </Button>
                    </>
                }
            />

            <Dialog
                open={confirmDelete}
                onClose={() => setConfirmDelete(false)}
                title={`Supprimer « ${workspace.name} » ?`}
                description='Notes, mots de passe, appareils et réglages de cet espace seront détruits pour tous ses membres. Cette action est irréversible.'
                onSubmit={() => void admin.remove(() => void refresh())}
                footer={
                    <>
                        <Button variant='secondary' onClick={() => setConfirmDelete(false)}>
                            Annuler
                        </Button>
                        <Button
                            variant='danger'
                            onClick={() => void admin.remove(() => void refresh())}
                            disabled={admin.busy}
                        >
                            {admin.busy ? 'Suppression…' : 'Supprimer définitivement'}
                        </Button>
                    </>
                }
            />
        </div>
    );
}
