import { useEffect, useState } from 'react';

import { ApiError } from '@/api/http';
import Button from '@/Components/Button';
import { Checkbox } from '@/Components/Checkbox';
import { Dialog } from '@/Components/Dialog';
import TextInput from '@/Components/TextInput';
import { cancelRemoteTwoFactor, loginRemote, submitRemoteTwoFactor, type RemoteEntry } from '@/stores/remoteInstances';

import styles from './RemoteLogin.module.css';

interface RemoteLoginProps {
    /** L'instance à ouvrir ; `null` ferme le dialogue. */
    entry: RemoteEntry | null;
    onClose: () => void;
    /** La session est ouverte là-bas. */
    onConnected: (instanceId: number) => void;
}

function humanize(err: unknown): string {
    if (err instanceof ApiError) {
        switch (err.code) {
            case 'auth_invalid':
                return 'Identifiant, mot de passe ou code incorrect.';
            case 'auth_expired':
                return 'La vérification a expiré. Recommencez.';
            case 'rate_limited':
                return 'Trop de tentatives, réessayez plus tard.';
            case 'network':
                return 'Instance injoignable, ou qui n’autorise pas cette adresse à s’y connecter.';
            default:
                return err.message || 'La connexion a échoué.';
        }
    }
    return 'La connexion a échoué.';
}

/**
 * Connexion au compte d'une instance distante. Les identifiants partent du
 * navigateur vers cette instance et nulle part ailleurs : le serveur d'ici ne
 * les voit pas, et le mot de passe n'est jamais gardé.
 */
export function RemoteLogin({ entry, onClose, onConnected }: RemoteLoginProps) {
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [code, setCode] = useState('');
    const [challenge, setChallenge] = useState<string | null>(null);
    const [remember, setRemember] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    const instanceId = entry?.instance.id ?? null;
    useEffect(() => {
        setUsername('');
        setPassword('');
        setCode('');
        setChallenge(null);
        setError(null);
        setLoading(false);
    }, [instanceId]);

    const close = (): void => {
        if (instanceId !== null && challenge) cancelRemoteTwoFactor(instanceId, challenge);
        setPassword('');
        setCode('');
        setChallenge(null);
        onClose();
    };

    const submit = async (): Promise<void> => {
        if (instanceId === null || loading) return;
        setError(null);
        setLoading(true);
        try {
            if (challenge) {
                await submitRemoteTwoFactor(instanceId, { code: code.trim(), challenge }, remember);
            } else {
                const step = await loginRemote(instanceId, { username: username.trim(), password }, remember);
                if (step.twoFactorRequired) {
                    setChallenge(step.challenge);
                    return;
                }
            }
            setPassword('');
            setCode('');
            setChallenge(null);
            onConnected(instanceId);
        } catch (e) {
            // Un défi épuisé ou expiré ne se rejoue pas : retour au mot de passe.
            if (e instanceof ApiError && e.code === 'auth_expired') setChallenge(null);
            setError(humanize(e));
        } finally {
            setLoading(false);
        }
    };

    const ready = challenge ? code.trim().length >= 6 : Boolean(username.trim() && password);

    return (
        <Dialog
            open={entry !== null}
            onClose={close}
            title={entry ? `Se connecter à ${entry.instance.label}` : ''}
            width={420}
            onSubmit={() => void submit()}
            footer={
                <>
                    <Button variant='secondary' onClick={close} disabled={loading}>
                        Annuler
                    </Button>
                    <Button onClick={() => void submit()} disabled={!ready || loading}>
                        {loading ? 'Connexion…' : challenge ? 'Vérifier' : 'Se connecter'}
                    </Button>
                </>
            }
        >
            <div className={styles.form}>
                <p className={styles.hint}>
                    {challenge
                        ? 'Saisissez le code de votre application d’authentification, ou un code de secours.'
                        : `Votre compte sur ${entry?.instance.origin ?? ''}. Vos identifiants ne passent que par ce navigateur.`}
                </p>
                {challenge ? (
                    <label className={styles.field}>
                        <span className={styles.fieldLabel}>Code de vérification</span>
                        <TextInput
                            value={code}
                            onChange={(e) => setCode(e.target.value)}
                            inputMode='numeric'
                            autoComplete='one-time-code'
                            maxLength={24}
                            autoFocus
                        />
                    </label>
                ) : (
                    <>
                        <label className={styles.field}>
                            <span className={styles.fieldLabel}>Identifiant</span>
                            <TextInput
                                value={username}
                                onChange={(e) => setUsername(e.target.value)}
                                autoComplete='off'
                                autoCapitalize='none'
                                spellCheck={false}
                                autoFocus
                            />
                        </label>
                        <label className={styles.field}>
                            <span className={styles.fieldLabel}>Mot de passe</span>
                            <TextInput
                                type='password'
                                enableShowHideButton
                                autoComplete='off'
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                            />
                        </label>
                        <Checkbox checked={remember} onChange={setRemember}>
                            Retenir sur cet appareil
                        </Checkbox>
                    </>
                )}
                {error && (
                    <p className={styles.error} role='alert'>
                        {error}
                    </p>
                )}
            </div>
        </Dialog>
    );
}

export default RemoteLogin;
