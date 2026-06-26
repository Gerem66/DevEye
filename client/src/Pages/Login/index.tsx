import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { ApiError, post } from '../../api/http';
import { useAuth } from '../../auth/AuthProvider';
import { isHomeReady, onHomeReady } from '../../stores/homeReady';
import { TextInput } from '../../Components';
import { z } from 'zod';
import './style.css';

const twoFaResponseSchema = z.object({
    user: z.unknown(),
    workspaces: z.unknown()
});

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
 * `CardPhase` drives the card's geometry/content (kept in React state — this part
 * is purely declarative and reliable):
 * - `form`      : open card showing the login or 2FA form.
 * - `collapsing`: card animates down to a 3px bar (a submit is in progress).
 * - `auto`      : auto-login on boot — instantly collapsed, no transition, no form.
 */
type CardPhase = 'form' | 'collapsing' | 'auto';

/** Extra classes appended to `.login-card` for each phase (see style.css). */
const CARD_PHASE_CLASS: Record<CardPhase, string> = {
    form: '',
    collapsing: ' card-to-progressbar',
    auto: ' card-to-progressbar auto-login'
};

// The fill's own timing (0.3s delay + 1s sweep) lives in style.css; PROGRESS_MS
// above must stay equal to their sum so the splash fades exactly as it completes.

function LoginPage() {
    const { status, login, refresh } = useAuth();
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const [twoFaRequired, setTwoFaRequired] = useState(false);
    const [twoFaCode, setTwoFaCode] = useState('');
    // Start collapsed when the app is still resolving the session (`unknown`), so
    // an auto-login lands directly on the bar with no flash of the open card.
    const [phase, setPhase] = useState<CardPhase>(status === 'unknown' ? 'auto' : 'form');
    // Whether the progress bar is filling. This is the ONLY state behind the fill:
    // a single boolean → a `filling` class → a CSS transition on `transform`.
    const [filling, setFilling] = useState(false);

    const cardRef = useRef<HTMLDivElement | null>(null);
    const contentRef = useRef<HTMLDivElement | null>(null);
    const inputUsername = useRef<HTMLInputElement | null>(null);
    const inputPassword = useRef<HTMLInputElement | null>(null);
    const inputTwoFa = useRef<HTMLInputElement | null>(null);
    const animStartRef = useRef<number>(Date.now());

    const [hide, setHide] = useState(false);

    // The fill is a CSS transition on `transform: scaleX` (see style.css), toggled
    // by the `filling` class. `transform` runs on the compositor, so the fill keeps
    // animating even while a successful login mounts the (heavy) HomePage on the
    // main thread — a JS/rAF fill froze there. It also can't leak state between
    // attempts (it's pure declarative state) and behaves the same in every engine.
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
            // Reset the card only when the form is (re)shown. When authenticated the
            // login page is fading out, so keep the card collapsed — reverting it here
            // would flash the card back open during the fade.
            setPhase('form');
            setFilling(false);
            // LoginPage is never unmounted (only hidden), so wipe any residual form
            // state when the user lands back here — otherwise a previous 2FA prompt,
            // typed code or error would resurface after logout / session expiry.
            setTwoFaRequired(false);
            setTwoFaCode('');
            setPassword('');
            setError('');
            setLoading(false);
        }
    }, [status]);

    // Pin the card's height to its measured content so it can animate between the
    // login and (taller) 2FA layouts — and collapse to the progress bar — without
    // magic numbers or clipping. ResizeObserver keeps it correct if the content
    // reflows (font load, viewport change…).
    useLayoutEffect(() => {
        const card = cardRef.current;
        const content = contentRef.current;
        if (!card || !content) return;
        const sync = () => card.style.setProperty('--card-height', `${content.offsetHeight}px`);
        sync();
        const ro = new ResizeObserver(sync);
        ro.observe(content);
        return () => ro.disconnect();
    }, [twoFaRequired]);

    // Fade to the homepage only once authenticated, the progress-bar animation has
    // fully played, AND the home has its first data — so the transition always
    // lands on a clean, populated dashboard instead of a half-empty grid. The
    // animation is never cut short (we always wait out its remaining time), and a
    // cap keeps a stalled first load from trapping the user on the splash.
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
            if (result.twoFactorRequired) {
                // Let the whole collapse-and-fill animation finish before re-opening
                // the card as the 2FA prompt — like every other transition (success,
                // error), we never reveal the next view mid-fill. Consistent and clean.
                await waitUntil(startedAt, PROGRESS_MS);
                stopAnim();
                // The username/password already authenticated against the server, so
                // clear them now: going Back must return to a fresh form, and they
                // must never linger past this first step whatever the 2FA outcome.
                setUsername('');
                setPassword('');
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

    /**
     * Leave the 2FA prompt ("Back"): reset the form and tell the server to drop
     * the pending challenge (and any DEK stashed at the password step). The
     * server call is best-effort — a network error here must not trap the user
     * on the 2FA card, so we reset the UI regardless.
     */
    const onCancel2FA = () => {
        setTwoFaRequired(false);
        setTwoFaCode('');
        setError('');
        void post('/api/auth/2fa/cancel', {}).catch(() => {});
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

                <div ref={cardRef} className={'login-card' + CARD_PHASE_CLASS[phase]} onKeyDown={onKeyDown}>
                    <div className={'progress-bar' + (filling ? ' filling' : '')} />

                    <div ref={contentRef} className='login-card-content'>
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
                                <button className='cancel' onClick={onCancel2FA}>
                                    Retour
                                </button>
                            </>
                        )}
                    </div>
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
