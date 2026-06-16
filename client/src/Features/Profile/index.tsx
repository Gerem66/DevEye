import { useState } from 'react';

import { useAuth } from '@/auth/AuthProvider';
import { Dialog } from '@/Components/Dialog';
import { StatusBadge } from '@/Components/StatusBadge';
import Button from '@/Components/Button';

import type { FeatureProps } from '@/Features/types';
import styles from './style.module.css';

function formatDate(time: number): string {
    const str = new Date(time * 1000).toLocaleDateString('fr-FR', {
        hour: '2-digit',
        minute: '2-digit',
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });
    return str.charAt(0).toUpperCase() + str.slice(1);
}

export default function FeatureProfile({ user, workspace }: FeatureProps) {
    const { workspaces, logout } = useAuth();
    const [inDevOpen, setInDevOpen] = useState(false);

    return (
        <div className={styles.container}>
            <header className={styles.header}>
                <h2 className={styles.title}>Profil</h2>
                <p className={styles.subtitle}>Vos informations personnelles</p>
            </header>

            <div className={styles.card}>
                <div className={styles.identity}>
                    <button className={styles.avatar} onClick={() => setInDevOpen(true)} aria-label="Modifier l'image">
                        <img src={`./images/${workspace.logo}`} alt={workspace.name} />
                        <span className={styles.avatarHint}>Modifier</span>
                    </button>
                    <span className={styles.name}>{workspace.name}</span>
                </div>

                <dl className={styles.info}>
                    <div className={styles.row}>
                        <dt>Adresse e-mail</dt>
                        <dd>{user.email}</dd>
                    </div>
                    <div className={styles.row}>
                        <dt>Nombre d&apos;entreprises</dt>
                        <dd>{Math.max(workspaces.length - 1, 0)}</dd>
                    </div>
                    <div className={styles.row}>
                        <dt>Double authentification</dt>
                        <dd>
                            <StatusBadge tone='warning' dot={false}>
                                Désactivée
                            </StatusBadge>
                        </dd>
                    </div>
                    <div className={styles.row}>
                        <dt>Chiffrage par mot de passe</dt>
                        <dd>
                            <StatusBadge tone='warning' dot={false}>
                                Désactivé
                            </StatusBadge>
                        </dd>
                    </div>
                    <div className={styles.row}>
                        <dt>Mot de passe</dt>
                        <dd>
                            <Button variant='secondary' onClick={() => setInDevOpen(true)}>
                                Modifier
                            </Button>
                        </dd>
                    </div>
                    <div className={styles.row}>
                        <dt>Dernière connexion</dt>
                        <dd>{user.lastLogin ? formatDate(user.lastLogin) : 'Première connexion'}</dd>
                    </div>
                    <div className={styles.row}>
                        <dt>Créé le</dt>
                        <dd>{formatDate(user.created)}</dd>
                    </div>
                </dl>

                <Button variant='danger' icon='logout' className={styles.logout} onClick={() => void logout()}>
                    Se déconnecter
                </Button>
            </div>

            <Dialog
                open={inDevOpen}
                onClose={() => setInDevOpen(false)}
                title='En développement'
                footer={<Button onClick={() => setInDevOpen(false)}>Compris</Button>}
            >
                Cette fonctionnalité est en cours de développement. Elle sera bientôt disponible.
            </Dialog>
        </div>
    );
}
