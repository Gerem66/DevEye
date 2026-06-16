import { useEffect, useRef, useState } from 'react';

import { ApiError, post } from '../../api/http';
import { useAuth } from '../../auth/AuthProvider';
import { TextInput } from '../../Components';
import { z } from 'zod';
import './style.css';

const twoFaResponseSchema = z.object({
    user: z.unknown(),
    workspaces: z.unknown()
});

/** Total duration of the card → progress-bar fill (0.5s delay + 1s fill). */
const PROGRESS_MS = 1500;
/** Minimum visible time for a failed attempt before the error shows. */
const ERROR_MS = PROGRESS_MS;

/** Block until at least `minMs` has elapsed since `startedAt` (keeps the
 *  progress/error animations from flashing on fast responses). */
function waitUntil(startedAt: number, minMs: number): Promise<void> {
    const remaining = minMs - (Date.now() - startedAt);
    return remaining > 0 ? new Promise((resolve) => setTimeout(resolve, remaining)) : Promise.resolve();
}

function LoginPage() {
    const { status, login, refresh } = useAuth();
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const [twoFaRequired, setTwoFaRequired] = useState(false);
    const [twoFaCode, setTwoFaCode] = useState('');

    const cardRef = useRef<HTMLDivElement | null>(null);
    const inputUsername = useRef<HTMLInputElement | null>(null);
    const inputPassword = useRef<HTMLInputElement | null>(null);
    const inputTwoFa = useRef<HTMLInputElement | null>(null);
    const animStartRef = useRef<number>(Date.now());

    const [hide, setHide] = useState(false);

    useEffect(() => {
        if (status === 'unknown') {
            cardRef.current?.classList.add('card-to-progressbar', 'auto-login');
        } else if (status !== 'authenticated') {
            // Reset the card only when the form is (re)shown. When authenticated the
            // login page is fading out, so keep the card collapsed — reverting it here
            // would flash the card back open during the fade.
            cardRef.current?.classList.remove('card-to-progressbar', 'auto-login');
        }
    }, [status]);

    // Fade to the homepage only once authenticated AND the progress-bar animation
    // has fully played — the transition must wait for the animation to finish.
    useEffect(() => {
        if (status !== 'authenticated') {
            setHide(false);
            return;
        }
        const remaining = Math.max(0, PROGRESS_MS - (Date.now() - animStartRef.current));
        const timer = setTimeout(() => setHide(true), remaining);
        return () => clearTimeout(timer);
    }, [status]);

    const startAnim = () => {
        animStartRef.current = Date.now();
        cardRef.current?.classList.add('card-to-progressbar');
    };
    const stopAnim = () => {
        cardRef.current?.classList.remove('card-to-progressbar', 'auto-login');
    };

    const onSubmit = async () => {
        if (loading) return;
        if (username === '') {
            inputUsername.current?.focus();
            return;
        }
        if (password === '') {
            inputPassword.current?.focus();
            return;
        }

        inputUsername.current?.blur();
        inputPassword.current?.blur();
        setError('');
        setLoading(true);
        startAnim();
        const startedAt = Date.now();

        try {
            const result = await login(username, password);
            if (result.twoFactorRequired) {
                stopAnim();
                setTwoFaRequired(true);
                setTimeout(() => inputTwoFa.current?.focus(), 50);
            } else {
                await waitUntil(startedAt, PROGRESS_MS);
                setPassword('');
            }
        } catch (e) {
            await waitUntil(startedAt, ERROR_MS);
            if (e instanceof ApiError) {
                setError(humanizeAuthError(e));
            } else {
                setError('Erreur réseau');
            }
            setPassword('');
            inputPassword.current?.focus();
            stopAnim();
        } finally {
            setLoading(false);
        }
    };

    const onSubmit2FA = async () => {
        if (loading || twoFaCode.length !== 6) return;
        setError('');
        setLoading(true);
        startAnim();
        const startedAt = Date.now();
        try {
            await post('/api/auth/2fa/challenge', { code: twoFaCode }, twoFaResponseSchema);
            await refresh();
            await waitUntil(startedAt, PROGRESS_MS);
        } catch (e) {
            await waitUntil(startedAt, ERROR_MS);
            if (e instanceof ApiError) {
                setError('Code invalide');
            } else {
                setError('Erreur réseau');
            }
            setTwoFaCode('');
            inputTwoFa.current?.focus();
            stopAnim();
        } finally {
            setLoading(false);
        }
    };

    const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'Enter') {
            if (twoFaRequired) void onSubmit2FA();
            else void onSubmit();
        }
    };

    return (
        <div className={'login' + (hide ? ' hide' : '')}>
            <div className='form'>
                <span className='title'>
                    <b>Dev</b> <p>Eye</p>
                </span>

                <div ref={cardRef} className='login-card' onKeyDown={onKeyDown}>
                    <div className='progress-bar' />

                    {!twoFaRequired ? (
                        <>
                            <div className='input-group'>
                                <TextInput
                                    ref={inputUsername}
                                    placeholder="Nom d'utilisateur"
                                    value={username}
                                    onChange={(e) => setUsername(e.target.value)}
                                    autoFocus
                                />
                                <span className='icon icon-user'></span>
                            </div>

                            <div className='input-group'>
                                <TextInput
                                    ref={inputPassword}
                                    type='password'
                                    placeholder='Mot de passe'
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    error={error}
                                />
                                <span className='icon icon-lock' />
                            </div>

                            <button className='submit' onClick={onSubmit} disabled={loading}>
                                Se connecter
                            </button>
                        </>
                    ) : (
                        <>
                            <p className='twofa-prompt'>
                                Entrez le code à 6 chiffres de votre application d&apos;authentification
                            </p>
                            <div className='input-group'>
                                <TextInput
                                    ref={inputTwoFa}
                                    placeholder='000000'
                                    value={twoFaCode}
                                    onChange={(e) => setTwoFaCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                                    error={error}
                                />
                                <span className='icon icon-shield' />
                            </div>

                            <button
                                className='submit'
                                onClick={onSubmit2FA}
                                disabled={loading || twoFaCode.length !== 6}
                            >
                                Vérifier
                            </button>
                            <button
                                className='cancel'
                                onClick={() => {
                                    setTwoFaRequired(false);
                                    setTwoFaCode('');
                                    setError('');
                                }}
                            >
                                Retour
                            </button>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}

function humanizeAuthError(err: ApiError): string {
    switch (err.code) {
        case 'auth_invalid':
            return 'Identifiants invalides';
        case 'auth_required':
        case 'auth_expired':
            return 'Session expirée';
        case 'rate_limited':
            return 'Trop de tentatives, réessayez plus tard';
        case 'network':
            return 'Serveur injoignable';
        default:
            return err.message || 'Erreur inconnue';
    }
}

export default LoginPage;
