import { useEffect, useState } from 'react';

import Button from '@/Components/Button';
import { Dialog } from '@/Components/Dialog';
import SelectInput from '@/Components/SelectInput';
import TextInput from '@/Components/TextInput';
import { useAuth } from '@/auth/AuthProvider';
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
                {isShared && isOwner && (
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
                                disabled={!isOwner}
                            />
                            <Button
                                onClick={() => void admin.rename(name.trim())}
                                disabled={!nameChanged || admin.busy || !isOwner}
                            >
                                Renommer
                            </Button>
                        </div>
                        {!isOwner && <p className={styles.hint}>Seul le propriétaire peut renommer cet espace.</p>}
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

                {isShared && isOwner && (
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
