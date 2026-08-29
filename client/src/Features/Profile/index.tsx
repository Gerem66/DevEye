import { useRef, useState } from 'react';

import { useAuth } from '@/auth/AuthProvider';
import { ws } from '@/api/ws';
import { Dialog } from '@/Components/Dialog';
import Button from '@/Components/Button';
import Switch from '@/Components/Switch';

import type { FeatureProps } from '@/Features/types';
import { ACCEPTED_TYPES, avatarSrc, fileToAvatarDataUrl } from './avatar';
import { PasswordDialog } from './PasswordDialog';
import { USER_COLOR_OPTIONS, userColorVar } from './userColors';
import styles from './style.module.css';
import { HIDE_LIVE_CURSORS } from '@/live/hideCursors';
import { requestOpenView } from '@/stores/viewRequest';
import { useWorkspaceState } from '@/stores/workspace';

import type { CSSProperties } from 'react';
import type { UserColor } from '@deveye/types';

const SECURITY_MAX = 3;

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
    const { logout, updateUser } = useAuth();
    const { workspaces } = useWorkspaceState();
    const [passwordOpen, setPasswordOpen] = useState(false);

    const securityScore =
        (user.security.twoFactor ? 1 : 0) +
        (user.security.passwordEncryption ? 1 : 0) +
        (user.security.reAuthValidation ? 1 : 0);
    const securityFull = securityScore >= SECURITY_MAX;
    const [uploading, setUploading] = useState(false);
    const [avatarError, setAvatarError] = useState<string | null>(null);
    const [savingColor, setSavingColor] = useState(false);
    const [savingCursors, setSavingCursors] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const showCursors = !user.settings.includes(HIDE_LIVE_CURSORS);

    // La couleur est appliquée localement d'abord : c'est un réglage cosmétique
    // dont l'effet doit se voir à l'instant du clic. En cas d'échec on la remet
    // à sa valeur d'avant plutôt que de laisser croire au changement.
    const onPickColor = async (color: UserColor) => {
        if (savingColor || color === user.color) return;
        const previous = user.color;
        setSavingColor(true);
        updateUser({ color });
        try {
            await ws.send('user.setColor', { color });
        } catch {
            updateUser({ color: previous });
        } finally {
            setSavingColor(false);
        }
    };

    // Comme la couleur : l'état local part devant, l'effet du clic étant
    // immédiat à l'écran, et ne revient en arrière que si le serveur refuse.
    const onToggleCursors = async (visible: boolean) => {
        if (savingCursors) return;
        const previous = user.settings;
        setSavingCursors(true);
        updateUser({
            settings: visible ? previous.filter((s) => s !== HIDE_LIVE_CURSORS) : [...previous, HIDE_LIVE_CURSORS]
        });
        try {
            // Le serveur renvoie le sac tel qu'il vient de l'écrire : s'aligner
            // dessus plutôt que sur notre calcul évite de diverger d'un onglet à
            // l'autre si un drapeau a bougé ailleurs entre-temps.
            const res = await ws.send('user.setSetting', { flag: HIDE_LIVE_CURSORS, enabled: !visible });
            updateUser({ settings: res.settings });
        } catch {
            updateUser({ settings: previous });
        } finally {
            setSavingCursors(false);
        }
    };

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
                        <dt>Espaces de travail</dt>
                        <dd>{Math.max(workspaces.length - 1, 0)}</dd>
                    </div>
                    <div className={styles.row}>
                        <dt>Couleur de présence</dt>
                        <dd className={styles.swatches}>
                            {USER_COLOR_OPTIONS.map((option) => (
                                <button
                                    key={option.value}
                                    type='button'
                                    className={`${styles.swatch} ${
                                        user.color === option.value ? styles.swatchActive : ''
                                    }`}
                                    style={{ '--swatch': userColorVar(option.value) } as CSSProperties}
                                    disabled={savingColor}
                                    aria-label={option.label}
                                    aria-pressed={user.color === option.value}
                                    title={option.label}
                                    onClick={() => void onPickColor(option.value)}
                                />
                            ))}
                        </dd>
                    </div>
                    <div className={`${styles.row} ${styles.rowAction}`}>
                        <dt>
                            Curseurs des autres
                            <span className={styles.rowHint}>Masqués, votre curseur disparaît aussi</span>
                        </dt>
                        <dd>
                            <Switch
                                checked={showCursors}
                                onChange={(visible) => void onToggleCursors(visible)}
                                disabled={savingCursors}
                                aria-label='Afficher les curseurs des autres membres'
                            />
                        </dd>
                    </div>
                    <div className={styles.row}>
                        <dt>Sécurité</dt>
                        <dd>
                            {/* Un score incomplet sans porte de sortie est un
                                cul-de-sac : le compteur ouvre la feature qui le
                                fait bouger. */}
                            <button
                                type='button'
                                className={`${styles.securityScore} ${styles.securityScoreBtn} ${
                                    securityFull ? styles.full : styles.partial
                                }`}
                                onClick={() => requestOpenView('security')}
                                title='Ouvrir la sécurité'
                                aria-label={`Sécurité ${securityScore} sur ${SECURITY_MAX} — ouvrir la sécurité`}
                            >
                                {securityScore} / {SECURITY_MAX}
                            </button>
                        </dd>
                    </div>
                    <div className={`${styles.row} ${styles.rowAction}`}>
                        <dt>Mot de passe</dt>
                        <dd>
                            <Button variant='secondary' onClick={() => setPasswordOpen(true)}>
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

            <PasswordDialog open={passwordOpen} onClose={() => setPasswordOpen(false)} />

            <Dialog
                open={avatarError !== null}
                onClose={() => setAvatarError(null)}
                title="Modification de l'image"
                onSubmit={() => setAvatarError(null)}
                footer={<Button onClick={() => setAvatarError(null)}>Compris</Button>}
            >
                {avatarError}
            </Dialog>
        </div>
    );
}
