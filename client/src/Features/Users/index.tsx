import { useCallback, useEffect, useState } from 'react';
import type { AdminUser } from '@deveye/types';

import { ws, WsError } from '@/api/ws';
import Button from '@/Components/Button';
import { Dialog } from '@/Components/Dialog';
import SelectInput from '@/Components/SelectInput';
import { StatusBadge } from '@/Components/StatusBadge';
import { useAuth } from '@/auth/AuthProvider';
import { avatarSrc } from '@/Features/Profile/avatar';
import { useResourceVersion } from '@/stores/invalidation';
import styles from './Users.module.css';

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

    const [users, setUsers] = useState<AdminUser[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [loading, setLoading] = useState(true);
    const [confirmDelete, setConfirmDelete] = useState<AdminUser | null>(null);
    const load = useCallback(async () => {
        try {
            setUsers((await ws.send('admin.userList', {})).users);
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
    // qui vient de naître, ou un autre administrateur à l'œuvre.
    const usersVersion = useResourceVersion('admin.userList');
    useEffect(() => {
        void load();
    }, [load, usersVersion]);

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

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <div className={styles.headerText}>
                    <h2 className={styles.title}>Utilisateurs</h2>
                    <p className={styles.subtitle}>Comptes DevEye</p>
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
            </div>

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
