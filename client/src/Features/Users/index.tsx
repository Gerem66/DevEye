import { useCallback, useEffect, useState } from 'react';
import type { AdminInvite, AdminUser } from '@deveye/types';

import { ws, WsError } from '@/api/ws';
import Button from '@/Components/Button';
import { Dialog } from '@/Components/Dialog';
import SelectInput from '@/Components/SelectInput';
import { StatusBadge } from '@/Components/StatusBadge';
import TextInput from '@/Components/TextInput';
import { useAuth } from '@/auth/AuthProvider';
import { avatarSrc } from '@/Features/Profile/avatar';
import { useResourceVersion } from '@/stores/invalidation';
import { useWorkspaceState } from '@/stores/workspace';
import styles from './Users.module.css';

const TTL_CHOICES: { label: string; value: string }[] = [
    { label: '1 jour', value: '86400' },
    { label: '7 jours', value: '604800' },
    { label: '30 jours', value: '2592000' }
];

/** Date lisible, ou « jamais » pour un compte qui ne s'est pas encore connecté. */
function when(epoch: number): string {
    if (!epoch) return 'jamais';
    return new Date(epoch * 1000).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * Page « Utilisateurs » : la gestion des comptes à l'échelle du site, par
 * opposition aux membres d'un espace.
 *
 * Réservée à l'administrateur global. L'entrée de menu est déjà masquée pour les
 * autres, mais chaque commande est gatée serveur — le masquage n'est qu'un
 * confort.
 */
export default function FeatureUsers() {
    const { user } = useAuth();
    const { workspaces } = useWorkspaceState();

    const [users, setUsers] = useState<AdminUser[]>([]);
    const [invites, setInvites] = useState<AdminInvite[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [loading, setLoading] = useState(true);
    const [inviteOpen, setInviteOpen] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState<AdminUser | null>(null);
    const [copied, setCopied] = useState<string | null>(null);

    const [email, setEmail] = useState('');
    const [wsId, setWsId] = useState('null');
    const [ttl, setTtl] = useState('604800');

    const load = useCallback(async () => {
        try {
            const [u, i] = await Promise.all([ws.send('admin.userList', {}), ws.send('admin.inviteList', {})]);
            setUsers(u.users);
            setInvites(i.invites);
        } catch (e) {
            setError(
                e instanceof WsError && e.code === 'forbidden'
                    ? 'Accès réservé aux administrateurs.'
                    : 'Impossible de charger les comptes.'
            );
        } finally {
            setLoading(false);
        }
    }, []);

    // La page se relit aussi quand le changement vient d'ailleurs : un compte
    // né d'une invitation, ou un autre administrateur à l'œuvre.
    const usersVersion = useResourceVersion('admin.userList');
    const invitesVersion = useResourceVersion('admin.inviteList');
    useEffect(() => {
        void load();
    }, [load, usersVersion, invitesVersion]);

    const run = async (fn: () => Promise<void>, fallback: string): Promise<void> => {
        setError(null);
        setBusy(true);
        try {
            await fn();
            await load();
        } catch (e) {
            setError(e instanceof WsError ? e.message : fallback);
        } finally {
            setBusy(false);
        }
    };

    const copy = (url: string): void => {
        void navigator.clipboard.writeText(url).then(() => {
            setCopied(url);
            setTimeout(() => setCopied(null), 1500);
        });
    };

    // Seuls les espaces partagés se rejoignent : on n'entre pas dans le
    // personnel de quelqu'un d'autre.
    const shared = workspaces.filter((w) => w.kind === 'shared');

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <div className={styles.headerText}>
                    <h2 className={styles.title}>Utilisateurs</h2>
                    <p className={styles.subtitle}>Comptes DevEye et invitations en attente</p>
                </div>
                <div className={styles.headerActions}>
                    <Button icon='add' onClick={() => setInviteOpen(true)}>
                        Inviter
                    </Button>
                </div>
            </div>

            {error && <div className={styles.errorBanner}>{error}</div>}

            <div className={styles.sections}>
                <section className={styles.section}>
                    <span className={styles.sectionLabel}>Comptes ({users.length})</span>
                    <div className={styles.card}>
                        {loading ? (
                            <p className={styles.empty}>Chargement…</p>
                        ) : (
                            users.map((u) => {
                                const self = u.id === user?.id;
                                return (
                                    <div
                                        key={u.id}
                                        className={`${styles.row} ${u.status === 'suspended' ? styles.suspended : ''}`}
                                    >
                                        <img className={styles.avatar} src={avatarSrc(u.avatar)} alt='' />
                                        <div className={styles.rowText}>
                                            <span className={styles.rowTitle}>
                                                {u.username} {self && <span className={styles.defaultTag}>vous</span>}
                                            </span>
                                            <span className={styles.rowMeta}>
                                                {u.email} · {u.workspaceCount} espace(s) · dernière connexion{' '}
                                                {when(u.lastLogin)}
                                            </span>
                                        </div>

                                        <StatusBadge
                                            className={styles.statusBadge}
                                            tone={u.status === 'suspended' ? 'danger' : 'success'}
                                        >
                                            {u.status === 'suspended' ? 'suspendu' : 'actif'}
                                        </StatusBadge>

                                        {/* Se retirer soi-même l'administration ou se suspendre
                                            laisserait potentiellement le site sans administrateur :
                                            le serveur le refuse, l'UI ne le propose pas. */}
                                        <SelectInput
                                            className={styles.roleSelect}
                                            value={u.role}
                                            disabled={self || busy}
                                            onChange={(e) =>
                                                void run(
                                                    () =>
                                                        ws
                                                            .send('admin.setUserRole', {
                                                                userId: u.id,
                                                                role: e.target.value as 'user' | 'admin'
                                                            })
                                                            .then(() => undefined),
                                                    'Changement de rôle impossible.'
                                                )
                                            }
                                            aria-label={`Rôle de ${u.username}`}
                                        >
                                            <option value='user'>Utilisateur</option>
                                            <option value='admin'>Administrateur</option>
                                        </SelectInput>

                                        {!self && (
                                            <>
                                                <button
                                                    type='button'
                                                    className={styles.actionBtn}
                                                    title={u.status === 'suspended' ? 'Réactiver' : 'Suspendre'}
                                                    aria-label={u.status === 'suspended' ? 'Réactiver' : 'Suspendre'}
                                                    disabled={busy}
                                                    onClick={() =>
                                                        void run(
                                                            () =>
                                                                ws
                                                                    .send('admin.setUserStatus', {
                                                                        userId: u.id,
                                                                        status:
                                                                            u.status === 'suspended'
                                                                                ? 'active'
                                                                                : 'suspended'
                                                                    })
                                                                    .then(() => undefined),
                                                            'Changement de statut impossible.'
                                                        )
                                                    }
                                                >
                                                    <span
                                                        className={`icon icon-${u.status === 'suspended' ? 'play' : 'pause'}`}
                                                    />
                                                </button>
                                                <button
                                                    type='button'
                                                    className={`${styles.actionBtn} ${styles.actionDanger}`}
                                                    title='Supprimer le compte'
                                                    aria-label={`Supprimer ${u.username}`}
                                                    disabled={busy}
                                                    onClick={() => setConfirmDelete(u)}
                                                >
                                                    <span className='icon icon-trash' />
                                                </button>
                                            </>
                                        )}
                                    </div>
                                );
                            })
                        )}
                    </div>
                </section>

                <section className={styles.section}>
                    <span className={styles.sectionLabel}>Invitations en attente</span>
                    <div className={styles.card}>
                        {invites.length === 0 ? (
                            <p className={styles.empty}>Aucune invitation active.</p>
                        ) : (
                            invites.map((i) => (
                                <div key={i.token} className={styles.row}>
                                    <div className={styles.rowText}>
                                        <span className={styles.token}>{i.url}</span>
                                        <span className={styles.rowMeta}>
                                            {i.email ?? 'ouverte à toute adresse'}
                                            {i.workspaceName && ` · rejoint « ${i.workspaceName} »`} ·{' '}
                                            {i.maxUses === null
                                                ? `${i.uses} utilisation(s)`
                                                : `${i.uses} / ${i.maxUses}`}{' '}
                                            · créée par {i.createdBy}
                                        </span>
                                    </div>
                                    <button
                                        type='button'
                                        className={styles.actionBtn}
                                        title='Copier le lien'
                                        aria-label='Copier le lien'
                                        onClick={() => copy(i.url)}
                                    >
                                        <span className={`icon icon-${copied === i.url ? 'success' : 'copy'}`} />
                                    </button>
                                    <button
                                        type='button'
                                        className={`${styles.actionBtn} ${styles.actionDanger}`}
                                        title='Révoquer'
                                        aria-label='Révoquer cette invitation'
                                        disabled={busy}
                                        onClick={() =>
                                            void run(
                                                () =>
                                                    ws
                                                        .send('admin.inviteRevoke', { token: i.token })
                                                        .then(() => undefined),
                                                'Révocation impossible.'
                                            )
                                        }
                                    >
                                        <span className='icon icon-trash' />
                                    </button>
                                </div>
                            ))
                        )}
                    </div>
                </section>
            </div>

            <Dialog
                open={inviteOpen}
                onClose={() => setInviteOpen(false)}
                title='Inviter un utilisateur'
                description='Le lien permet de créer un compte DevEye. Sans adresse, il fonctionne pour n’importe qui.'
                width={460}
                footer={
                    <>
                        <Button variant='secondary' onClick={() => setInviteOpen(false)}>
                            Annuler
                        </Button>
                        <Button
                            disabled={busy}
                            onClick={() => {
                                void run(
                                    () =>
                                        ws
                                            .send('admin.inviteCreate', {
                                                email,
                                                workspaceId: wsId === 'null' ? null : Number(wsId),
                                                ttlSeconds: Number(ttl),
                                                maxUses: 1
                                            })
                                            .then(() => undefined),
                                    'Création de l’invitation impossible.'
                                );
                                setInviteOpen(false);
                                setEmail('');
                            }}
                        >
                            Créer le lien
                        </Button>
                    </>
                }
            >
                <span className={styles.sectionLabel}>Adresse (facultative)</span>
                <TextInput
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    maxLength={320}
                    placeholder='personne@exemple.fr'
                    aria-label='Adresse email'
                />
                <span className={styles.sectionLabel}>Rejoint un espace</span>
                <SelectInput value={wsId} onChange={(e) => setWsId(e.target.value)} aria-label='Espace rejoint'>
                    <option value='null'>Aucun</option>
                    {shared.map((w) => (
                        <option key={w.id} value={w.id}>
                            {w.name}
                        </option>
                    ))}
                </SelectInput>
                <span className={styles.sectionLabel}>Validité</span>
                <SelectInput value={ttl} onChange={(e) => setTtl(e.target.value)} aria-label='Validité du lien'>
                    {TTL_CHOICES.map((c) => (
                        <option key={c.value} value={c.value}>
                            {c.label}
                        </option>
                    ))}
                </SelectInput>
            </Dialog>

            <Dialog
                open={confirmDelete !== null}
                onClose={() => setConfirmDelete(null)}
                title={confirmDelete ? `Supprimer « ${confirmDelete.username} » ?` : 'Supprimer'}
                description='Son espace personnel, les espaces partagés dont il est propriétaire et tout leur contenu seront détruits. Cette action est irréversible.'
                footer={
                    <>
                        <Button variant='secondary' onClick={() => setConfirmDelete(null)}>
                            Annuler
                        </Button>
                        <Button
                            variant='danger'
                            disabled={busy}
                            onClick={() => {
                                const target = confirmDelete;
                                setConfirmDelete(null);
                                if (target) {
                                    void run(
                                        () => ws.send('admin.deleteUser', { userId: target.id }).then(() => undefined),
                                        'Suppression impossible.'
                                    );
                                }
                            }}
                        >
                            {busy ? 'Suppression…' : 'Supprimer définitivement'}
                        </Button>
                    </>
                }
            />
        </div>
    );
}
