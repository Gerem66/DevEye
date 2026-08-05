import { useEffect, useState } from 'react';

import Button from '@/Components/Button';
import { Dialog } from '@/Components/Dialog';
import SelectInput from '@/Components/SelectInput';
import TextInput from '@/Components/TextInput';
import type { WorkspaceRole } from 'deveye-types';
import { useAuth } from '@/auth/AuthProvider';
import { useWorkspacePermissions } from '@/stores/workspace';
import RoleDialog from './RoleDialog';
import { avatarSrc } from '@/Features/Profile/avatar';
import { formatExpiry, formatUses, useWorkspaceAdmin } from './useWorkspaceAdmin';
import styles from './Workspace.module.css';

/** Durées proposées pour un lien, comme les codes de liaison d'appareil. */
const TTL_CHOICES: { label: string; value: number | null }[] = [
    { label: '1 heure', value: 3600 },
    { label: '1 jour', value: 86400 },
    { label: '7 jours', value: 604800 },
    { label: 'N’expire pas', value: null }
];

const USES_CHOICES: { label: string; value: number | null }[] = [
    { label: '1 personne', value: 1 },
    { label: '5 personnes', value: 5 },
    { label: 'Illimité', value: null }
];

/**
 * Page « Espace de travail » : renommer, membres, invitations, et la zone
 * destructive (quitter / supprimer).
 *
 * Un espace personnel n'affiche que son nom : il n'a ni membres ni invitations,
 * et ne se quitte pas. Plutôt que de griser des sections vides, on ne les rend
 * simplement pas.
 */
export default function FeatureWorkspace() {
    const admin = useWorkspaceAdmin();
    const { refresh } = useAuth();
    const { workspace, isShared, isOwner } = admin;

    const [name, setName] = useState('');
    const [inviteOpen, setInviteOpen] = useState(false);
    const [ttl, setTtl] = useState<string>('86400');
    const [maxUses, setMaxUses] = useState<string>('1');
    const [confirmLeave, setConfirmLeave] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [copied, setCopied] = useState<string | null>(null);
    const [roleEdited, setRoleEdited] = useState<{ role: WorkspaceRole | null } | null>(null);

    const { can } = useWorkspacePermissions();
    const canManageMembers = can('workspace.members');
    const canManageRoles = can('workspace.roles');
    const canRename = can('workspace.manage');

    /** Rôle actuellement porté par un membre. */
    const roleOf = (userId: number): number | null =>
        admin.memberRoles.find((m) => m.userId === userId)?.roleId ?? null;

    useEffect(() => {
        setName(workspace?.name ?? '');
    }, [workspace?.name]);

    if (!workspace) return null;

    const nameChanged = name.trim() !== '' && name.trim() !== workspace.name;

    const copy = (url: string): void => {
        void navigator.clipboard.writeText(url).then(() => {
            setCopied(url);
            setTimeout(() => setCopied(null), 1500);
        });
    };

    const parse = (v: string): number | null => (v === 'null' ? null : Number(v));

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
                {isShared && canManageMembers && (
                    <div className={styles.headerActions}>
                        <Button icon='add' onClick={() => setInviteOpen(true)}>
                            Inviter
                        </Button>
                    </div>
                )}
            </div>

            {admin.error && <div className={styles.errorBanner}>{admin.error}</div>}

            <div className={styles.sections}>
                <section className={styles.section}>
                    <span className={styles.sectionLabel}>Général</span>
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
                        {!canRename && <p className={styles.hint}>Vous n’avez pas le droit de renommer cet espace.</p>}
                    </div>
                </section>

                {isShared && (
                    <section className={styles.section}>
                        <span className={styles.sectionLabel}>Membres</span>
                        <div className={styles.card}>
                            {workspace.users.map((u) => {
                                const owner = u.id === workspace.ownerUserId;
                                return (
                                    <div key={u.id} className={styles.row}>
                                        <img className={styles.avatar} src={avatarSrc(u.avatar)} alt='' />
                                        <div className={styles.rowText}>
                                            <span className={styles.rowTitle}>{u.username}</span>
                                            <span className={styles.rowMeta}>{owner ? 'Propriétaire' : u.email}</span>
                                        </div>
                                        {/* Le propriétaire n'a pas de rôle : il a tout par
                                            construction, et lui en donner un laisserait croire
                                            qu'on peut le lui retirer. */}
                                        {!owner && canManageMembers && (
                                            <SelectInput
                                                value={String(roleOf(u.id) ?? '')}
                                                onChange={(e) =>
                                                    void admin.assignRole(
                                                        u.id,
                                                        e.target.value === '' ? null : Number(e.target.value)
                                                    )
                                                }
                                                aria-label={`Rôle de ${u.username}`}
                                            >
                                                <option value=''>Aucun rôle</option>
                                                {admin.roles.map((r) => (
                                                    <option key={r.id} value={r.id}>
                                                        {r.name}
                                                    </option>
                                                ))}
                                            </SelectInput>
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

                {isShared && canManageRoles && (
                    <section className={styles.section}>
                        <div className={styles.sectionHeader}>
                            <span className={styles.sectionLabel}>Rôles</span>
                            <Button variant='secondary' icon='plus' onClick={() => setRoleEdited({ role: null })}>
                                Nouveau rôle
                            </Button>
                        </div>
                        <div className={styles.card}>
                            {admin.roles.length === 0 ? (
                                <p className={styles.empty}>
                                    Aucun rôle. Sans rôle, un membre invité n’a accès à rien.
                                </p>
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
                                        {!r.isDefault && (
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

                {isShared && canManageMembers && (
                    <section className={styles.section}>
                        <div className={styles.sectionHeader}>
                            <span className={styles.sectionLabel}>Liens d’invitation</span>
                        </div>
                        <div className={styles.card}>
                            {admin.invites.length === 0 ? (
                                <p className={styles.empty}>
                                    {admin.loadingInvites ? 'Chargement…' : 'Aucun lien actif.'}
                                </p>
                            ) : (
                                admin.invites.map((inv) => (
                                    <div key={inv.token} className={styles.row}>
                                        <div className={styles.rowText}>
                                            <span className={styles.token}>{inv.url}</span>
                                            <span className={styles.rowMeta}>
                                                {formatUses(inv.uses, inv.maxUses)} · {formatExpiry(inv.expiresAt)} ·
                                                créé par {inv.createdBy}
                                            </span>
                                        </div>
                                        <button
                                            type='button'
                                            className={styles.actionBtn}
                                            title='Copier le lien'
                                            aria-label='Copier le lien'
                                            onClick={() => copy(inv.url)}
                                        >
                                            <span className={`icon icon-${copied === inv.url ? 'success' : 'copy'}`} />
                                        </button>
                                        <button
                                            type='button'
                                            className={`${styles.actionBtn} ${styles.actionDanger}`}
                                            title='Révoquer ce lien'
                                            aria-label='Révoquer ce lien'
                                            onClick={() => void admin.revokeInvite(inv.token)}
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

                {isShared && isOwner && admin.sharedKey?.applicable && (
                    <section className={styles.section}>
                        <span className={styles.sectionLabel}>Chiffrement</span>
                        <div className={styles.card}>
                            {admin.sharedKey.enabled ? (
                                <p className={styles.hint}>
                                    Cet espace possède sa propre clé de chiffrement : tous ses membres en lisent le
                                    contenu, indépendamment de votre mot de passe.
                                </p>
                            ) : (
                                <>
                                    <p className={styles.hint}>
                                        Le contenu de cet espace est actuellement chiffré avec <strong>votre</strong>{' '}
                                        clé. Si vous utilisez le chiffrement par mot de passe, vous êtes donc le seul à
                                        pouvoir le lire. Lui donner sa propre clé le rend lisible par tous ses membres.
                                    </p>
                                    {admin.sharedKey.blockers.map((b) => (
                                        <p key={b} className={styles.hint}>
                                            ⚠️ {b}
                                        </p>
                                    ))}
                                    <div className={styles.dangerZone}>
                                        <p className={styles.hint}>À faire une seule fois, session déverrouillée.</p>
                                        <Button
                                            onClick={() => void admin.enableSharedKey()}
                                            disabled={admin.busy || admin.sharedKey.blockers.length > 0}
                                        >
                                            {admin.busy ? 'Conversion…' : 'Activer la clé d’espace'}
                                        </Button>
                                    </div>
                                </>
                            )}
                        </div>
                    </section>
                )}

                {isShared && (
                    <section className={styles.section}>
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
                title='Nouveau lien d’invitation'
                description='Toute personne disposant du lien pourra rejoindre cet espace, dans la limite fixée ici.'
                width={440}
                onSubmit={() => {
                    void admin.createInvite(parse(ttl), parse(maxUses));
                    setInviteOpen(false);
                }}
                footer={
                    <>
                        <Button variant='secondary' onClick={() => setInviteOpen(false)}>
                            Annuler
                        </Button>
                        <Button
                            onClick={() => {
                                void admin.createInvite(parse(ttl), parse(maxUses));
                                setInviteOpen(false);
                            }}
                            disabled={admin.busy}
                        >
                            Créer le lien
                        </Button>
                    </>
                }
            >
                <label className={styles.sectionLabel} htmlFor='invite-ttl'>
                    Validité
                </label>
                <SelectInput id='invite-ttl' value={ttl} onChange={(e) => setTtl(e.target.value)}>
                    {TTL_CHOICES.map((c) => (
                        <option key={String(c.value)} value={String(c.value)}>
                            {c.label}
                        </option>
                    ))}
                </SelectInput>
                <label className={styles.sectionLabel} htmlFor='invite-uses'>
                    Nombre d’utilisations
                </label>
                <SelectInput id='invite-uses' value={maxUses} onChange={(e) => setMaxUses(e.target.value)}>
                    {USES_CHOICES.map((c) => (
                        <option key={String(c.value)} value={String(c.value)}>
                            {c.label}
                        </option>
                    ))}
                </SelectInput>
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
