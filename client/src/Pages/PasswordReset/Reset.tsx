import { useEffect, useState } from 'react';
import {
    passwordResetCompleteRequestSchema,
    passwordResetCompleteResponseSchema,
    passwordResetVerifyResponseSchema,
    type PasswordResetCompleteResponse,
    type PasswordResetVerifyResponse
} from '@deveye/types';

import { ApiError, post } from '@/api/http';
import TextInput from '@/Components/TextInput';
import { copyText } from '@/copyText';
import { LoginScene } from '@/Pages/Login/Scene';
import { TextLink } from '@/Pages/Login/TextLink';
import { humanizeSignupError } from '@/Pages/Signup/errors';

const MIN_PASSWORD = 8;
/** `XXXX-XXXX-XXXX-XXXX` ; le serveur ignore tirets et espaces. */
const RECOVERY_LENGTH = 19;
const RECOVERY_MIN = 16;

interface FormError {
    message: string;
    field: 'code' | 'password' | null;
}

/** Ouverte depuis le mail : le nouveau mot de passe, précédé du code de récupération pour un compte chiffré. */
export function PasswordResetForm({
    token,
    onLogin,
    onRestart
}: {
    token: string;
    onLogin: (username?: string) => void;
    onRestart: () => void;
}) {
    const [who, setWho] = useState<PasswordResetVerifyResponse | null>(null);
    const [dead, setDead] = useState(false);
    const [code, setCode] = useState('');
    const [lostCode, setLostCode] = useState(false);
    const [password, setPassword] = useState('');
    const [confirm, setConfirm] = useState('');
    const [error, setError] = useState<FormError | null>(null);
    const [saving, setSaving] = useState(false);
    const [done, setDone] = useState<PasswordResetCompleteResponse | null>(null);
    const [copied, setCopied] = useState<boolean | null>(null);

    useEffect(() => {
        post('/api/auth/password-reset/verify', { token }, passwordResetVerifyResponseSchema)
            .then(setWho)
            .catch(() => setDead(true));
    }, [token]);

    const submit = (): void => {
        if (saving || !who) return;
        if (who.recoveryRequired && code.replace(/-/g, '').length < RECOVERY_MIN) {
            return setError({ message: 'Saisissez votre code de récupération en entier', field: 'code' });
        }
        if (password.length < MIN_PASSWORD) {
            return setError({ message: `Le mot de passe fait ${MIN_PASSWORD} caractères minimum`, field: 'password' });
        }
        if (password !== confirm) {
            return setError({ message: 'Les mots de passe ne correspondent pas', field: 'password' });
        }
        const parsed = passwordResetCompleteRequestSchema.safeParse({
            token,
            password,
            recoveryCode: who.recoveryRequired ? code : undefined
        });
        if (!parsed.success) return setError({ message: 'Vérifiez les informations saisies', field: null });

        setError(null);
        setSaving(true);
        post('/api/auth/password-reset/complete', parsed.data, passwordResetCompleteResponseSchema)
            .then(setDone)
            .catch((e: unknown) => {
                if (e instanceof ApiError && e.code === 'not_found') return setDead(true);
                const field = e instanceof ApiError && e.code === 'auth_invalid' ? 'code' : null;
                setError({ message: humanizeSignupError(e), field });
            })
            .finally(() => setSaving(false));
    };

    const footer = (
        <TextLink href='/' shown={!saving} onNavigate={() => onLogin()}>
            Se connecter
        </TextLink>
    );

    if (dead) {
        return (
            <LoginScene footer={footer}>
                <p className='signup-intro'>Ce lien est invalide ou a expiré.</p>
                <button type='button' className='submit' onClick={onRestart}>
                    Demander un nouveau lien
                </button>
            </LoginScene>
        );
    }

    if (done) {
        return (
            <LoginScene>
                <p className='signup-status'>
                    <span className='icon icon-check-circle' /> Mot de passe changé
                </p>
                {done.recoveryCode ? (
                    <>
                        <p className='signup-intro'>
                            Voici votre nouveau code de récupération : l’ancien ne sert plus. Conservez-le en lieu sûr,
                            il ne sera plus affiché.
                        </p>
                        <code className='reset-code'>{done.recoveryCode}</code>
                        <button
                            type='button'
                            className='cancel'
                            onClick={() => void copyText(done.recoveryCode ?? '').then(setCopied)}
                        >
                            {copied === null ? 'Copier le code' : copied ? 'Code copié' : 'Copie impossible, notez-le'}
                        </button>
                    </>
                ) : (
                    <p className='signup-intro'>
                        Connectez-vous avec votre nouveau mot de passe. Vos autres sessions ont été fermées.
                    </p>
                )}
                <button type='button' className='submit' onClick={() => onLogin(done.username)}>
                    Se connecter
                </button>
            </LoginScene>
        );
    }

    if (who?.recoveryRequired && lostCode) {
        return (
            <LoginScene footer={footer}>
                <p className='signup-intro'>
                    Sans ce code, le mot de passe ne peut pas être réinitialisé : vos données sont chiffrées par votre
                    mot de passe actuel, et rien d’autre ne les ouvre, pas même le service.
                </p>
                <p className='signup-intro'>
                    Ce lien n’y a rien changé : si votre mot de passe vous revient, connectez-vous simplement avec. Un
                    nouveau code se crée ensuite dans les réglages Sécurité.
                </p>
                <button type='button' className='cancel' onClick={() => setLostCode(false)}>
                    J’ai retrouvé mon code
                </button>
            </LoginScene>
        );
    }

    return (
        <LoginScene onSubmit={submit} footer={footer}>
            <p className='signup-intro'>
                {who ? (
                    who.recoveryRequired ? (
                        <>
                            Bonjour <b>{who.username}</b>, vos données sont chiffrées par votre mot de passe : saisissez
                            le code de récupération remis à l’activation du chiffrement, puis le nouveau mot de passe.
                        </>
                    ) : (
                        <>
                            Bonjour <b>{who.username}</b>, choisissez votre nouveau mot de passe.
                        </>
                    )
                ) : (
                    'Vérification du lien…'
                )}
            </p>

            {who?.recoveryRequired && (
                <div className='input-group'>
                    <TextInput
                        placeholder='XXXX-XXXX-XXXX-XXXX'
                        value={code}
                        onChange={(e) =>
                            setCode(
                                e.target.value
                                    .toUpperCase()
                                    .replace(/[^A-Z0-9-]/g, '')
                                    .slice(0, RECOVERY_LENGTH)
                            )
                        }
                        autoComplete='off'
                        spellCheck={false}
                        autoFocus
                        error={error?.field === 'code' ? error.message : undefined}
                    />
                    <span className='icon icon-key' />
                </div>
            )}

            <div className='input-group'>
                <TextInput
                    type='password'
                    placeholder='Nouveau mot de passe'
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete='new-password'
                    enableShowHideButton
                    disabled={!who}
                    autoFocus={!who?.recoveryRequired}
                />
            </div>

            <div className='input-group'>
                <TextInput
                    type='password'
                    placeholder='Confirmez le mot de passe'
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    autoComplete='new-password'
                    enableShowHideButton
                    disabled={!who}
                    error={error?.field === 'password' ? error.message : undefined}
                />
            </div>

            <p className={error ? 'signup-error' : 'signup-hint'}>
                {error?.message ?? `${MIN_PASSWORD} caractères minimum`}
            </p>

            <button className='submit' type='submit' disabled={saving || !who}>
                Changer le mot de passe
            </button>

            {who?.recoveryRequired && (
                <button type='button' className='login-link' onClick={() => setLostCode(true)}>
                    Je n’ai plus mon code
                </button>
            )}
        </LoginScene>
    );
}
