import { useState } from 'react';
import { passwordResetStartRequestSchema } from '@deveye/types';

import { post } from '@/api/http';
import TextInput from '@/Components/TextInput';
import { LoginScene } from '@/Pages/Login/Scene';
import { TextLink } from '@/Pages/Login/TextLink';
import { humanizeSignupError } from '@/Pages/Signup/errors';

/** La demande du lien, par l'adresse du compte. */
export function PasswordResetStart({ onLogin }: { onLogin: () => void }) {
    const [email, setEmail] = useState('');
    const [error, setError] = useState('');
    const [sending, setSending] = useState(false);
    const [sentTo, setSentTo] = useState<string | null>(null);

    const submit = (): void => {
        if (sending) return;
        const parsed = passwordResetStartRequestSchema.safeParse({ email: email.trim() });
        if (!parsed.success) return setError('Adresse email invalide');
        setError('');
        setSending(true);
        post('/api/auth/password-reset', parsed.data)
            .then(() => setSentTo(parsed.data.email))
            .catch((e: unknown) => setError(humanizeSignupError(e)))
            .finally(() => setSending(false));
    };

    const footer = (
        <TextLink href='/' shown={!sending} onNavigate={onLogin}>
            Se connecter
        </TextLink>
    );

    if (sentTo) {
        return (
            <LoginScene footer={footer}>
                <p className='signup-status'>
                    <span className='icon icon-mail' /> Demande envoyée
                </p>
                {/* Le serveur répond pareil qu'un compte existe ou non : la page aussi. */}
                <p className='signup-intro'>
                    Si un compte utilise l’adresse <b>{sentTo}</b>, un mail vient d’y partir avec un lien pour choisir
                    un nouveau mot de passe. Il est valable 1 h.
                </p>
                <button type='button' className='cancel' onClick={() => setSentTo(null)}>
                    Utiliser une autre adresse
                </button>
            </LoginScene>
        );
    }

    return (
        <LoginScene onSubmit={submit} footer={footer}>
            <p className='signup-intro'>
                Indiquez l’adresse email de votre compte : vous y recevrez un lien pour choisir un nouveau mot de passe.
            </p>

            <div className='input-group'>
                <TextInput
                    type='email'
                    placeholder='Adresse email'
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete='email'
                    maxLength={320}
                    autoFocus
                    error={error || undefined}
                />
                <span className='icon icon-mail' />
            </div>

            <p className={error ? 'signup-error' : 'signup-hint'}>{error}</p>

            <button className='submit' type='submit' disabled={sending}>
                Envoyer le lien
            </button>
        </LoginScene>
    );
}
