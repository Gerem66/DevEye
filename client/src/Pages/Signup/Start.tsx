import { useEffect, useState } from 'react';
import {
    signupAvailabilitySchema,
    signupStartRequestSchema,
    signupStartResponseSchema,
    signupStatusSchema,
    type SignupStatus
} from '@deveye/types';

import { get, post } from '@/api/http';
import Checkbox from '@/Components/Checkbox';
import TextInput from '@/Components/TextInput';
import { legalLinks } from '@/legal';
import { humanizeSignupError, signupErrorField } from './errors';
import { TextLink } from '@/Pages/Login/TextLink';
import { LoginScene } from '@/Pages/Login/Scene';

const POLL_MS = 3000;
/** Survit au rechargement de l'onglet qui attend, pas à sa fermeture. */
const WATCH_KEY = 'deveye.signupWatch';

interface Watch {
    token: string;
    email: string;
}

/** `field` : le champ qui passe en rouge, aucun quand l'erreur ne tient pas à la saisie. */
interface FormError {
    message: string;
    field: 'username' | 'email' | null;
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
    const [error, setError] = useState<FormError | null>(null);
    const [sending, setSending] = useState(false);
    const [watch, setWatch] = useState<Watch | null>(readWatch);
    const [state, setState] = useState<SignupStatus['state']>('pending');
    // Les conditions à accepter sont celles du site : sans site, rien à cocher.
    const [siteUrl, setSiteUrl] = useState<string | null>(null);
    const [terms, setTerms] = useState(false);

    useEffect(() => {
        get('/api/auth/signup', signupAvailabilitySchema)
            .then((r) => setSiteUrl(r.siteUrl))
            .catch(() => setSiteUrl(null));
    }, []);

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
        const parsed = signupStartRequestSchema.safeParse({
            username,
            email,
            plan: plan ?? undefined,
            termsAccepted: siteUrl === null || terms
        });
        if (!parsed.success) {
            const field = parsed.error.issues[0]?.path[0];
            if (field === 'username') {
                setError({
                    message:
                        username.length < 3
                            ? 'Le nom d’utilisateur fait 3 caractères minimum'
                            : 'Le nom d’utilisateur ne prend que des lettres, des chiffres et _ . -',
                    field: 'username'
                });
            } else if (field === 'email') setError({ message: 'Adresse email invalide', field: 'email' });
            else setError({ message: 'Vérifiez les informations saisies', field: null });
            return;
        }
        setError(null);
        setSending(true);
        post('/api/auth/signup', parsed.data, signupStartResponseSchema)
            .then(({ watchToken }) => {
                const next = { token: watchToken, email: parsed.data.email };
                sessionStorage.setItem(WATCH_KEY, JSON.stringify(next));
                setState('pending');
                setWatch(next);
            })
            .catch((e: unknown) => setError({ message: humanizeSignupError(e), field: signupErrorField(e) }))
            .finally(() => setSending(false));
    };

    if (watch) {
        return (
            <LoginScene>
                {state === 'pending' && (
                    <>
                        <p className='signup-status'>
                            <span className='icon icon-mail' /> Mail envoyé
                        </p>
                        <p className='signup-intro'>
                            Ouvrez le lien reçu à <b>{watch.email}</b> pour choisir votre mot de passe. Il est valable 2
                            h.
                        </p>
                        <p className='signup-hint signup-waiting'>En attente de validation…</p>
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
            </LoginScene>
        );
    }

    return (
        <LoginScene
            onSubmit={submit}
            footer={
                <TextLink href='/' shown={!sending} onNavigate={onLogin}>
                    Se connecter
                </TextLink>
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
                    error={error?.field === 'username' ? error.message : undefined}
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
                    error={error?.field === 'email' ? error.message : undefined}
                />
                <span className='icon icon-mail' />
            </div>

            {siteUrl !== null && (
                <Checkbox checked={terms} onChange={setTerms} className='signup-terms'>
                    {/* Un seul enfant : le libellé de la case empile ses enfants, et les liens resteraient chacun sur leur ligne. */}
                    <span>
                        J’ai au moins 18 ans, j’ai lu et j’accepte les{' '}
                        <a href={legalLinks(siteUrl).terms} target='_blank' rel='noopener noreferrer'>
                            conditions d’utilisation
                        </a>{' '}
                        et la{' '}
                        <a href={legalLinks(siteUrl).privacy} target='_blank' rel='noopener noreferrer'>
                            politique de confidentialité
                        </a>
                        .
                    </span>
                </Checkbox>
            )}

            <p className={error ? 'signup-error' : 'signup-hint'}>{error?.message}</p>

            <button className='submit' type='submit' disabled={sending || (siteUrl !== null && !terms)}>
                Créer mon compte
            </button>
        </LoginScene>
    );
}
