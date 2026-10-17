import { useEffect, useState } from 'react';

import { ApiError } from '@/api/http';
import Button from '@/Components/Button';
import { Checkbox } from '@/Components/Checkbox';
import { Dialog } from '@/Components/Dialog';
import ErrorNote, { type ErrorNoteInput } from '@/Components/ErrorNote';
import TextInput from '@/Components/TextInput';
import {
    cancelRemoteLogin,
    loginRemote,
    resendRemoteCode,
    submitRemoteCode,
    type RemoteEntry,
    type RemoteLoginStep
} from '@/stores/remoteInstances';

import styles from './RemoteLogin.module.css';

interface RemoteLoginProps {
    /** L'instance à ouvrir ; `null` ferme le dialogue. */
    entry: RemoteEntry | null;
    onClose: () => void;
    /** La session est ouverte là-bas. */
    onConnected: (instanceId: number) => void;
}

function humanize(err: unknown): ErrorNoteInput {
    return { message: phrase(err), code: err instanceof ApiError ? err.code : null };
}

function phrase(err: unknown): string {
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

type Pending = Extract<RemoteLoginStep, { status: 'pending' }>;

/** Ce que l'étape en cours demande, dit simplement. */
function stepHint(pending: Pending): string {
    switch (pending.step) {
        case 'email':
            return `Un code vient d’être envoyé à ${pending.to ?? 'votre adresse de là-bas'}. Saisissez-le pour confirmer cette connexion.`;
        case 'sms':
            return `Un code vient d’être envoyé par SMS au ${pending.to ?? 'numéro de votre compte là-bas'}.`;
        case 'totp':
            return 'Saisissez le code de votre application d’authentification, ou un code de secours.';
    }
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
    const [pending, setPending] = useState<Pending | null>(null);
    const [trust, setTrust] = useState(false);
    const [remember, setRemember] = useState(false);
    const [error, setError] = useState<ErrorNoteInput | null>(null);
    const [loading, setLoading] = useState(false);

    const instanceId = entry?.instance.id ?? null;
    useEffect(() => {
        setUsername('');
        setPassword('');
        setCode('');
        setPending(null);
        setTrust(false);
        setError(null);
        setLoading(false);
    }, [instanceId]);

    const close = (): void => {
        if (instanceId !== null && pending) cancelRemoteLogin(instanceId, pending.challenge);
        setPassword('');
        setCode('');
        setPending(null);
        onClose();
    };

    /** L'étape suivante, ou la session ouverte là-bas. */
    const settle = (step: RemoteLoginStep): void => {
        if (step.status === 'pending') {
            setPending(step);
            setCode('');
            return;
        }
        setPassword('');
        setCode('');
        setPending(null);
        if (instanceId !== null) onConnected(instanceId);
    };

    const resend = async (): Promise<void> => {
        if (instanceId === null || !pending || loading) return;
        setError(null);
        try {
            settle(await resendRemoteCode(instanceId, pending.challenge, remember));
        } catch (e) {
            if (e instanceof ApiError && e.code === 'auth_expired') setPending(null);
            setError(humanize(e));
        }
    };

    const submit = async (): Promise<void> => {
        if (instanceId === null || loading) return;
        setError(null);
        setLoading(true);
        try {
            settle(
                pending
                    ? await submitRemoteCode(
                          instanceId,
                          { code: code.trim(), challenge: pending.challenge, trust: pending.step !== 'totp' && trust },
                          remember
                      )
                    : await loginRemote(instanceId, { username: username.trim(), password }, remember)
            );
        } catch (e) {
            // Une connexion épuisée ou expirée ne se rejoue pas : retour au mot de passe.
            if (e instanceof ApiError && e.code === 'auth_expired') setPending(null);
            setError(humanize(e));
        } finally {
            setLoading(false);
        }
    };

    const ready = pending ? code.trim().length >= 6 : Boolean(username.trim() && password);

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
                        {loading ? 'Connexion…' : pending ? 'Vérifier' : 'Se connecter'}
                    </Button>
                </>
            }
        >
            <div className={styles.form}>
                <p className={styles.hint}>
                    {pending
                        ? stepHint(pending)
                        : `Votre compte sur ${entry?.instance.origin ?? ''}. Vos identifiants ne passent que par ce navigateur.`}
                </p>
                {pending ? (
                    <>
                        <label className={styles.field}>
                            <span className={styles.fieldLabel}>Code de vérification</span>
                            <TextInput
                                key={pending.step}
                                value={code}
                                onChange={(e) => setCode(e.target.value)}
                                inputMode={pending.step === 'totp' ? 'text' : 'numeric'}
                                autoComplete='one-time-code'
                                maxLength={24}
                                autoFocus
                            />
                        </label>
                        {pending.step !== 'totp' && (
                            <>
                                <Checkbox checked={trust} onChange={setTrust}>
                                    Faire confiance à ce navigateur
                                </Checkbox>
                                <button
                                    type='button'
                                    className={styles.link}
                                    onClick={() => void resend()}
                                    disabled={loading}
                                >
                                    Renvoyer le code
                                </button>
                            </>
                        )}
                    </>
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
                <ErrorNote note={error} />
            </div>
        </Dialog>
    );
}

export default RemoteLogin;
