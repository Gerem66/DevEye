import { useEffect, useState } from 'react';
import {
    signupStartRequestSchema,
    signupStartResponseSchema,
    signupStatusSchema,
    type SignupStatus
} from '@deveye/types';

import { get, post } from '@/api/http';
import TextInput from '@/Components/TextInput';
import { humanizeSignupError } from './errors';
import { SignupScene } from './Scene';

const POLL_MS = 3000;
/** Survit au rechargement de l'onglet qui attend, pas à sa fermeture. */
const WATCH_KEY = 'deveye.signupWatch';

interface Watch {
    token: string;
    email: string;
}

function readWatch(): Watch | null {
    try {
        const raw = sessionStorage.getItem(WATCH_KEY);
        return raw ? (JSON.parse(raw) as Watch) : null;
    } catch {
        return null;
    }
}

/** Étapes 1 et 2 : la demande, puis l'attente du clic dans le mail. */
export function SignupStart({ plan, onLogin }: { plan: string | null; onLogin: () => void }) {
    const [username, setUsername] = useState('');
    const [email, setEmail] = useState('');
    const [error, setError] = useState('');
    const [sending, setSending] = useState(false);
    const [watch, setWatch] = useState<Watch | null>(readWatch);
    const [state, setState] = useState<SignupStatus['state']>('pending');

    useEffect(() => {
        if (!watch || state === 'done' || state === 'expired') return;
        const poll = (): void => {
            get('/api/auth/signup/status', signupStatusSchema, { 'X-Signup-Watch': watch.token })
                .then((s) => setState(s.state))
                .catch(() => undefined);
        };
        poll();
        const timer = setInterval(poll, POLL_MS);
        return () => clearInterval(timer);
    }, [watch, state]);

    const restart = (): void => {
        sessionStorage.removeItem(WATCH_KEY);
        setWatch(null);
        setState('pending');
    };

    const submit = (): void => {
        if (sending) return;
        const parsed = signupStartRequestSchema.safeParse({ username, email, plan: plan ?? undefined });
        if (!parsed.success) {
            if (username.trim().length < 3) setError('Le nom d’utilisateur fait 3 caractères minimum');
            else if (!email.includes('@')) setError('Adresse email invalide');
            else setError('Vérifiez les informations saisies');
            return;
        }
        setError('');
        setSending(true);
        post('/api/auth/signup', parsed.data, signupStartResponseSchema)
            .then(({ watchToken }) => {
                const next = { token: watchToken, email: parsed.data.email };
                sessionStorage.setItem(WATCH_KEY, JSON.stringify(next));
                setState('pending');
                setWatch(next);
            })
            .catch((e: unknown) => setError(humanizeSignupError(e)))
            .finally(() => setSending(false));
    };

    if (watch) {
        return (
            <SignupScene>
                {state === 'pending' && (
                    <>
                        <p className='signup-status'>
                            <span className='icon icon-mail' /> Mail envoyé
                        </p>
                        <p className='signup-intro'>
                            Ouvrez le lien reçu à <b>{watch.email}</b> pour choisir votre mot de passe. Il est valable 2
                            h.
                        </p>
                        <p className='signup-hint'>En attente de validation…</p>
                    </>
                )}
                {state === 'opened' && (
                    <>
                        <p className='signup-status'>
                            <span className='icon icon-spinner login-spin' /> Validation en cours
                        </p>
                        <p className='signup-intro'>Vous pouvez fermer cet onglet.</p>
                    </>
                )}
                {state === 'done' && (
                    <>
                        <p className='signup-status'>
                            <span className='icon icon-success' /> Compte créé
                        </p>
                        <p className='signup-intro'>Vous pouvez fermer cet onglet.</p>
                    </>
                )}
                {state === 'expired' && <p className='signup-intro'>Le lien a expiré.</p>}
                {state !== 'opened' && state !== 'done' && (
                    <button type='button' className='cancel' onClick={restart}>
                        {state === 'expired' ? 'Recommencer' : 'Utiliser une autre adresse'}
                    </button>
                )}
            </SignupScene>
        );
    }

    return (
        <SignupScene
            onSubmit={submit}
            footer={
                <button type='button' className='text-link' onClick={onLogin}>
                    Se connecter
                </button>
            }
        >
            <p className='signup-intro'>
                Créez votre compte DevEye. Le mot de passe se choisit après validation de l’adresse.
            </p>

            <div className='input-group'>
                <TextInput
                    placeholder='Nom d’utilisateur'
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    autoComplete='username'
                    maxLength={64}
                    autoFocus
                />
                <span className='icon icon-user' />
            </div>

            <div className='input-group'>
                <TextInput
                    type='email'
                    placeholder='Adresse email'
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete='email'
                    maxLength={320}
                    error={error}
                />
                <span className='icon icon-mail' />
            </div>

            <p className={error ? 'signup-error' : 'signup-hint'}>{error}</p>

            <button className='submit' type='submit' disabled={sending}>
                Créer mon compte
            </button>
        </SignupScene>
    );
}
