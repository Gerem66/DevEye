import { useRef, useState } from 'react';

import { useAuth } from '@/auth/AuthProvider';
import { ws } from '@/api/ws';
import { Dialog } from '@/Components/Dialog';
import { StatusBadge } from '@/Components/StatusBadge';
import Button from '@/Components/Button';

import type { FeatureProps } from '@/Features/types';
import { ACCEPTED_TYPES, avatarSrc, fileToAvatarDataUrl } from './avatar';
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
    const { workspaces, logout, updateUser } = useAuth();
    const [inDevOpen, setInDevOpen] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [avatarError, setAvatarError] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const onPickAvatar = () => {
        if (uploading) return;
        fileInputRef.current?.click();
    };

    const onAvatarSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = ''; // allow re-selecting the same file later
        if (!file) return;

        setUploading(true);
        try {
            const avatar = await fileToAvatarDataUrl(file);
            await ws.send('user.setAvatar', { avatar });
            updateUser({ avatar });
        } catch (err) {
            setAvatarError(err instanceof Error ? err.message : "La mise à jour de l'image a échoué.");
        } finally {
            setUploading(false);
        }
    };

    return (
        <div className={styles.container}>
            <header className={styles.header}>
                <h2 className={styles.title}>Profil</h2>
                <p className={styles.subtitle}>Vos informations personnelles</p>
            </header>

            <div className={styles.card}>
                <div className={styles.identity}>
                    <button
                        className={styles.avatar}
                        onClick={onPickAvatar}
                        disabled={uploading}
                        aria-label="Modifier l'image de profil"
                    >
                        <img src={avatarSrc(user.avatar)} alt={user.username} />
                        <span className={styles.avatarHint}>{uploading ? 'Envoi…' : 'Modifier'}</span>
                    </button>
                    <input
                        ref={fileInputRef}
                        type='file'
                        accept={ACCEPTED_TYPES.join(',')}
                        hidden
                        onChange={(e) => void onAvatarSelected(e)}
                    />
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

            <Dialog
                open={avatarError !== null}
                onClose={() => setAvatarError(null)}
                title="Modification de l'image"
                footer={<Button onClick={() => setAvatarError(null)}>Compris</Button>}
            >
                {avatarError}
            </Dialog>
        </div>
    );
}
