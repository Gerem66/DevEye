import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { signupAvailabilitySchema, type LoginStep } from '@deveye/types';

import { ApiError, get } from '../../api/http';
import { useAuth, type LoginResult } from '../../auth/AuthProvider';
import { isHomeReady, onHomeReady } from '../../stores/homeReady';
import { Checkbox, TextInput } from '../../Components';
import StatusPageLink from '../../Components/StatusPageLink';
import { TextLink } from './TextLink';
import './style.css';

/** Entre deux envois d'un code par mail ou SMS ; le serveur tient le même délai. */
const RESEND_MS = 60_000;
const RECOVERY_LENGTH = 19;

/** L'étape en cours d'une connexion, dite simplement. */
function stepPrompt(step: LoginStep, to: string | undefined, recovery: boolean): string {
    switch (step) {
        case 'email':
            return `Un code à 6 chiffres vient d’être envoyé à ${to ?? 'votre adresse'}. Saisissez-le pour confirmer cette connexion.`;
        case 'sms':
            return `Un code à 6 chiffres vient d’être envoyé par SMS au ${to ?? 'numéro de votre compte'}.`;
        case 'totp':
            return recovery
                ? 'Entrez l’un de vos codes de secours. Il ne servira qu’une fois.'
                : 'Entrez le code à 6 chiffres de votre application d’authentification';
    }
}

const STEP_ICON: Record<LoginStep, string> = { email: 'icon-mail', sms: 'icon-phone', totp: 'icon-shield' };

/** Total duration of the card → progress-bar fill (0.3s delay + 1s fill, see the
 *  `.progress-bar.filling` transition in style.css — keep these in sync). */
const PROGRESS_MS = 1300;
/** Minimum visible time for a failed attempt before the error shows. */
const ERROR_MS = PROGRESS_MS;
/** Hard cap on how long the splash waits for the home to load past the
 *  progress-bar animation, so a stalled first load can't trap the user here. */
const HOME_READY_MAX_MS = 4000;

/** Block until at least `minMs` has elapsed since `startedAt` (keeps the
 *  progress/error animations from flashing on fast responses). */
function waitUntil(startedAt: number, minMs: number): Promise<void> {
    const remaining = minMs - (Date.now() - startedAt);
    return remaining > 0 ? new Promise((resolve) => setTimeout(resolve, remaining)) : Promise.resolve();
}

/**
 * The card's geometry/content:
 * - `form`      : open card showing the login or 2FA form.
 * - `collapsing`: card animates down to a 3px bar (a submit is in progress).
 * - `auto`      : auto-login on boot, instantly collapsed, no transition, no form.
 */
type CardPhase = 'form' | 'collapsing' | 'auto';

/** Extra classes appended to `.login-card` for each phase (see style.css). */
const CARD_PHASE_CLASS: Record<CardPhase, string> = {
    form: '',
    collapsing: ' card-to-progressbar',
    auto: ' card-to-progressbar auto-login'
};

interface LoginPageProps {
    onSignup?: () => void;
    /** Pendant la maintenance du site : le retour à sa page, à la place de l'inscription. */
    onBack?: () => void;
}

function LoginPage({ onSignup, onBack }: LoginPageProps) {
    const { status, unreachable, login, verifyLogin, resendLoginCode, cancelLogin } = useAuth();
    const [signupOpen, setSignupOpen] = useState(false);
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    // L'étape qu'attend la connexion après le mot de passe ; `null` : le formulaire.
    const [prompt, setPrompt] = useState<Exclude<LoginResult, null> | null>(null);
    const [code, setCode] = useState('');
    // À l'étape de l'application : un code de secours plutôt que six chiffres.
    const [recovery, setRecovery] = useState(false);
    const [trust, setTrust] = useState(false);
    const [resendAt, setResendAt] = useState(0);
    const [clock, setClock] = useState(Date.now());
    // Start collapsed when the app is still resolving the session (`unknown`), so
    // an auto-login lands directly on the bar with no flash of the open card.
    const [phase, setPhase] = useState<CardPhase>(status === 'unknown' ? 'auto' : 'form');
    // The only state behind the fill: a boolean, a `filling` class, a CSS
    // transition on `transform`.
    const [filling, setFilling] = useState(false);

    const cardRef = useRef<HTMLDivElement | null>(null);
    const contentRef = useRef<HTMLDivElement | null>(null);
    const inputUsername = useRef<HTMLInputElement | null>(null);
    const inputPassword = useRef<HTMLInputElement | null>(null);
    const inputCode = useRef<HTMLInputElement | null>(null);
    const animStartRef = useRef<number>(Date.now());

    // Montée alors que la session est déjà ouverte (au sortir de l'inscription),
    // la page naît effacée : rien à montrer, et son formulaire ne doit pas
    // paraître le temps de sa propre transition.
    const [hide, setHide] = useState(status === 'authenticated');

    // The fill is a CSS transition on `transform: scaleX` (see style.css), which
    // runs on the compositor: it keeps animating while a successful login mounts
    // the heavy HomePage on the main thread (a JS/rAF fill froze there).
    const startProgress = () => {
        animStartRef.current = Date.now();
        setFilling(true);
    };
    const clearProgress = () => setFilling(false);

    useEffect(() => {
        if (status === 'unknown') {
            // Auto-login on boot: collapse the card straight to the bar and fill it.
            setPhase('auto');
            setFilling(true);
        } else if (status === 'anonymous') {
            // Reset the card only when the form is (re)shown: when authenticated the
            // login page is fading out, reverting would flash the card open.
            setPhase('form');
            setFilling(false);
            // LoginPage is never unmounted, only hidden: wipe residual form state
            // (a previous step, code or error) on landing back here.
            setPrompt(null);
            setCode('');
            setPassword('');
            setError('');
            setLoading(false);
        }
    }, [status]);

    // Relu à chaque retour du formulaire : l'inscription se referme d'elle-même
    // une fois le premier compte créé.
    useEffect(() => {
        if (status !== 'anonymous') return;
        get('/api/auth/signup', signupAvailabilitySchema)
            .then((r) => setSignupOpen(r.open))
            .catch(() => setSignupOpen(false));
    }, [status]);

    // Pin the card's height to its measured content so it can animate between the
    // login and 2FA layouts, and collapse to the bar, without magic numbers.
    // ResizeObserver keeps it correct on reflow.
    useLayoutEffect(() => {
        const card = cardRef.current;
        const content = contentRef.current;
        if (!card || !content) return;
        const sync = () => card.style.setProperty('--card-height', `${content.offsetHeight}px`);
        sync();
        const ro = new ResizeObserver(sync);
        ro.observe(content);
        return () => ro.disconnect();
    }, [prompt, recovery]);

    // Fade to the homepage only once authenticated, the progress-bar animation
    // has fully played, and the home has its first data. A cap keeps a stalled
    // first load from trapping the user on the splash.
    useEffect(() => {
        if (status !== 'authenticated') {
            setHide(false);
            return;
        }
        let cancelled = false;
        let animTimer: ReturnType<typeof setTimeout> | undefined;
        let capTimer: ReturnType<typeof setTimeout> | undefined;
        let offReady: (() => void) | undefined;

        const hideAfterAnim = () => {
            const remaining = Math.max(0, PROGRESS_MS - (Date.now() - animStartRef.current));
            animTimer = setTimeout(() => {
                if (!cancelled) setHide(true);
            }, remaining);
        };
        // Stop waiting on home readiness (the listener + the safety cap).
        const stopWaiting = () => {
            clearTimeout(capTimer);
            offReady?.();
        };

        if (isHomeReady()) {
            hideAfterAnim();
        } else {
            offReady = onHomeReady(() => {
                stopWaiting();
                hideAfterAnim();
            });
            capTimer = setTimeout(() => {
                stopWaiting();
                hideAfterAnim();
            }, HOME_READY_MAX_MS);
        }

        return () => {
            cancelled = true;
            clearTimeout(animTimer);
            stopWaiting();
        };
    }, [status]);

    // Whenever the card (re)opens to a form, return focus to its primary field
    // once interactive (`loading` gates this so the disabled code input is never
    // focused).
    useEffect(() => {
        if (phase !== 'form' || loading) return;
        // `username` is read but intentionally NOT a dependency: we only refocus on a
        // reopen (phase/loading/prompt change), never while the user is typing.
        if (prompt) inputCode.current?.focus();
        else if (username !== '') inputPassword.current?.focus();
        else inputUsername.current?.focus();
    }, [phase, loading, prompt, recovery]);

    // Le compte à rebours de « Renvoyer le code », tant qu'il court.
    const resendIn = Math.max(0, Math.ceil((resendAt - clock) / 1000));
    useEffect(() => {
        if (resendAt <= Date.now()) return;
        const timer = window.setInterval(() => setClock(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, [resendAt]);

    /** Une étape s'ouvre : code vide, et pour un code envoyé, le délai avant d'en redemander un. */
    const openStep = (next: Exclude<LoginResult, null>) => {
        setPrompt(next);
        setCode('');
        setRecovery(false);
        setError('');
        if (next.step !== 'totp') {
            setResendAt(Date.now() + RESEND_MS);
            setClock(Date.now());
        }
    };

    /** La connexion en cours est tombée (expirée, trop de codes faux) : retour au mot de passe. */
    const backToForm = (message: string) => {
        setPrompt(null);
        setCode('');
        setTrust(false);
        setError(message);
    };

    // Collapse the card and (re)start the progress fill — a submit is under way.
    const startAnim = () => {
        setPhase('collapsing');
        startProgress();
    };
    // Re-open the card and clear the bar — back to the form (error / cancel).
    const stopAnim = () => {
        setPhase('form');
        clearProgress();
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
            if (result) {
                // Let the collapse-and-fill animation finish before re-opening the
                // card on the next step: it is never revealed mid-fill.
                await waitUntil(startedAt, PROGRESS_MS);
                stopAnim();
                // Already authenticated against the server: clear them now, Back
                // must return to a fresh form.
                setUsername('');
                setPassword('');
                setTrust(false);
                openStep(result);
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
            stopAnim();
        } finally {
            setLoading(false);
        }
    };

    const codeReady = (value: string): boolean =>
        value.length === (prompt?.step === 'totp' && recovery ? RECOVERY_LENGTH : 6);

    // `value` is passed explicitly by the input's auto-submit so we verify the
    // freshly-entered value without waiting for the `code` state to settle;
    // it defaults to the state for the Enter-key path.
    const onSubmitCode = async (value: string = code) => {
        if (loading || !prompt || !codeReady(value)) return;
        setError('');
        setLoading(true);
        startAnim();
        const startedAt = Date.now();
        try {
            const next = await verifyLogin(value, prompt.step !== 'totp' && trust);
            await waitUntil(startedAt, PROGRESS_MS);
            if (next) {
                stopAnim();
                openStep(next);
            }
        } catch (e) {
            await waitUntil(startedAt, ERROR_MS);
            if (e instanceof ApiError && e.code === 'auth_expired') backToForm(e.message);
            else if (e instanceof ApiError && e.code === 'auth_invalid') setError('Code incorrect');
            else setError(e instanceof ApiError ? humanizeAuthError(e) : 'Erreur réseau');
            setCode('');
            stopAnim();
        } finally {
            setLoading(false);
        }
    };

    const onResend = async () => {
        if (loading || !prompt || resendIn > 0) return;
        setError('');
        try {
            const next = await resendLoginCode();
            if (next) openStep(next);
        } catch (e) {
            const retryAfterMs = (e instanceof ApiError ? (e.details as { retryAfterMs?: unknown }) : null)
                ?.retryAfterMs;
            if (typeof retryAfterMs === 'number') {
                setResendAt(Date.now() + retryAfterMs);
                setClock(Date.now());
            } else if (e instanceof ApiError && e.code === 'auth_expired') backToForm(e.message);
            else setError(e instanceof ApiError ? humanizeAuthError(e) : 'Erreur réseau');
        }
    };

    /**
     * Leave the current step: reset the form and tell the server to drop the
     * pending login (and any DEK stashed at the password step). Best-effort:
     * a network error must not trap the user on the step card.
     */
    const onCancelStep = () => {
        setPrompt(null);
        setCode('');
        setTrust(false);
        setError('');
        cancelLogin();
    };

    const signupShown = signupOpen && phase === 'form' && !prompt && !loading;

    const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'Enter') {
            if (prompt) void onSubmitCode();
            else void onSubmit();
        }
    };

    return (
        <div className={'login' + (hide ? ' hide' : '')}>
            <div className='form'>
                <span className='title'>
                    <b>Dev</b> <p>Eye</p>
                </span>

                <div className='card-slot'>
                    <div ref={cardRef} className={'login-card' + CARD_PHASE_CLASS[phase]} onKeyDown={onKeyDown}>
                        <div className={'progress-bar' + (filling ? ' filling' : '')} />

                        <div ref={contentRef} className='login-card-content'>
                            {!prompt ? (
                                <>
                                    {onBack && (
                                        <p className='signup-intro'>
                                            Pendant la maintenance, seuls les administrateurs peuvent se connecter.
                                        </p>
                                    )}
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
                                    <p className='twofa-prompt'>{stepPrompt(prompt.step, prompt.to, recovery)}</p>
                                    <div className='input-group'>
                                        <TextInput
                                            ref={inputCode}
                                            placeholder={recovery ? 'XXXX-XXXX-XXXX-XXXX' : '000000'}
                                            value={code}
                                            inputMode={recovery ? 'text' : 'numeric'}
                                            autoComplete='one-time-code'
                                            disabled={loading}
                                            onChange={(e) => {
                                                const next = recovery
                                                    ? e.target.value
                                                          .toUpperCase()
                                                          .replace(/[^A-Z0-9-]/g, '')
                                                          .slice(0, RECOVERY_LENGTH)
                                                    : e.target.value.replace(/\D/g, '').slice(0, 6);
                                                setCode(next);
                                                // The app code needs no button: it goes the instant six
                                                // digits are there, typed or pasted. A mailed or texted
                                                // code waits for the trust box and « Valider ».
                                                if (prompt.step === 'totp' && !recovery && next.length === 6) {
                                                    void onSubmitCode(next);
                                                }
                                            }}
                                            error={error}
                                        />
                                        <span className={`icon ${STEP_ICON[prompt.step]}`} />
                                    </div>

                                    {prompt.step !== 'totp' && (
                                        <Checkbox
                                            checked={trust}
                                            onChange={setTrust}
                                            disabled={loading}
                                            className='login-trust'
                                        >
                                            Faire confiance à ce navigateur
                                        </Checkbox>
                                    )}

                                    {(prompt.step !== 'totp' || recovery) && (
                                        <button
                                            className='submit'
                                            onClick={() => void onSubmitCode()}
                                            disabled={loading || !codeReady(code)}
                                        >
                                            Valider
                                        </button>
                                    )}

                                    <button
                                        type='button'
                                        className='login-link'
                                        disabled={loading || (prompt.step !== 'totp' && resendIn > 0)}
                                        onClick={() => {
                                            if (prompt.step !== 'totp') {
                                                void onResend();
                                                return;
                                            }
                                            setRecovery((r) => !r);
                                            setCode('');
                                            setError('');
                                        }}
                                    >
                                        {prompt.step === 'totp'
                                            ? recovery
                                                ? 'Utiliser le code de l’application'
                                                : 'Utiliser un code de secours'
                                            : resendIn > 0
                                              ? `Renvoyer le code (${resendIn} s)`
                                              : 'Renvoyer le code'}
                                    </button>

                                    <button className='cancel' onClick={onCancelStep} disabled={loading}>
                                        {loading ? (
                                            <span className='icon icon-spinner login-spin' aria-label='Vérification' />
                                        ) : (
                                            'Retour'
                                        )}
                                    </button>
                                </>
                            )}
                        </div>
                    </div>
                    {/* Toujours monté, pour que son arrivée se joue aussi (l'ouverture
                        des inscriptions n'est connue qu'après coup) : seul `shown` change. */}
                    {onBack ? (
                        <TextLink href='/' shown={phase === 'form' && !prompt && !loading} onNavigate={onBack}>
                            Retour
                        </TextLink>
                    ) : (
                        onSignup && (
                            <TextLink href='/signup' shown={signupShown} onNavigate={onSignup}>
                                S’inscrire
                            </TextLink>
                        )
                    )}
                </div>

                {unreachable && (
                    <p className='unreachable'>
                        Serveur injoignable, reprise automatique…
                        <br />
                        <StatusPageLink>État des services</StatusPageLink>
                    </p>
                )}
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
