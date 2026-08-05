import { useLayoutEffect, useRef, useState } from 'react';
import { loginResponseSchema, registerRequestSchema } from 'deveye-types';

import { ApiError, post } from '@/api/http';
import TextInput from '@/Components/TextInput';
import { useAuth } from '@/auth/AuthProvider';
import './style.css';

/**
 * Jeton d'inscription présent dans l'URL, ou `null`.
 *
 * Même mécanique que les invitations d'espace : lu une fois au chargement, puis
 * effacé de la barre d'adresse une fois le compte créé.
 */
export function readRegisterToken(): string | null {
    const m = /^\/register\/([A-Za-z0-9_-]+)\/?$/.exec(window.location.pathname);
    return m ? m[1] : null;
}

/**
 * Durée de l'effondrement de la carte en barre, puis du remplissage.
 *
 * Doit rester égale à la somme des timings de `style.css` (0,3 s de délai + 1 s
 * de balayage) : c'est ce qui fait que la bascule vers l'accueil tombe pile à la
 * fin de l'animation, sans la couper ni la faire attendre.
 */
const PROGRESS_MS = 1300;

const MIN_PASSWORD = 8;

function humanize(e: unknown): string {
    if (!(e instanceof ApiError)) return 'Erreur inconnue';
    switch (e.code) {
        case 'forbidden':
            return 'Invitation invalide, expirée, ou réservée à une autre adresse';
        case 'conflict':
            return 'Ce nom d’utilisateur ou cette adresse est déjà pris';
        case 'validation':
            return 'Vérifiez les informations saisies';
        case 'rate_limited':
            return 'Trop de tentatives, réessayez plus tard';
        case 'network':
            return 'Serveur injoignable';
        default:
            return e.message || 'Erreur inconnue';
    }
}

/**
 * Création d'un compte à partir d'une invitation.
 *
 * L'inscription libre n'existe pas : cet écran n'est atteignable que par un lien
 * émis depuis la page Utilisateurs. Il reprend volontairement la scène du login
 * — même fond, même carte, même effondrement en barre de progression — parce que
 * c'est le même moment du parcours : on entre dans DevEye. Un écran d'aspect
 * différent donnerait l'impression d'avoir atterri ailleurs.
 */
export default function RegisterPage({ token, onDone }: { token: string; onDone: () => void }) {
    const { refresh } = useAuth();
    const [username, setUsername] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [collapsing, setCollapsing] = useState(false);

    const cardRef = useRef<HTMLDivElement | null>(null);
    const contentRef = useRef<HTMLDivElement | null>(null);

    // La carte épouse la hauteur de son contenu : mesurée plutôt que codée en
    // dur, elle reste juste quand un message d'erreur apparaît ou disparaît, et
    // `height` reste animable (ce que `auto` ne serait pas).
    useLayoutEffect(() => {
        const card = cardRef.current;
        const content = contentRef.current;
        if (!card || !content) return;
        const sync = (): void => card.style.setProperty('--card-height', `${content.offsetHeight}px`);
        sync();
        const ro = new ResizeObserver(sync);
        ro.observe(content);
        return () => ro.disconnect();
    }, []);

    const submit = (e?: React.FormEvent): void => {
        e?.preventDefault();
        if (collapsing) return;

        const parsed = registerRequestSchema.safeParse({ inviteToken: token, username, email, password });
        if (!parsed.success) {
            // Message précis plutôt que « champ invalide » : l'utilisateur n'a
            // aucun moyen de deviner quelle règle il enfreint.
            if (username.trim().length < 3) setError('Le nom d’utilisateur fait 3 caractères minimum');
            else if (!email.includes('@')) setError('Adresse email invalide');
            else if (password.length < MIN_PASSWORD)
                setError(`Le mot de passe fait ${MIN_PASSWORD} caractères minimum`);
            else setError('Vérifiez les informations saisies');
            return;
        }

        setError('');
        setCollapsing(true);
        void (async () => {
            try {
                await post('/api/auth/register', parsed.data, loginResponseSchema);
                // Le serveur a ouvert la session. On laisse la barre finir sa
                // course avant de basculer : couper l'animation en plein vol
                // donnerait un à-coup au moment le plus visible du parcours.
                await refresh();
                setTimeout(onDone, PROGRESS_MS);
            } catch (err) {
                setError(humanize(err));
                setCollapsing(false);
            }
        })();
    };

    const onKeyDown = (e: React.KeyboardEvent): void => {
        if (e.key === 'Enter') submit();
    };

    return (
        <div className='login'>
            <form className='form' onSubmit={submit}>
                <span className='title'>
                    <b>Dev</b> <p>Eye</p>
                </span>

                <div
                    ref={cardRef}
                    className={'login-card' + (collapsing ? ' card-to-progressbar' : '')}
                    onKeyDown={onKeyDown}
                >
                    <div className={'progress-bar' + (collapsing ? ' filling' : '')} />

                    <div ref={contentRef} className='login-card-content'>
                        <p className='register-intro'>
                            Vous avez été invité à rejoindre DevEye. Choisissez vos identifiants.
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
                            />
                            <span className='icon icon-mail' />
                        </div>

                        <div className='input-group'>
                            <TextInput
                                type='password'
                                placeholder='Mot de passe'
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                autoComplete='new-password'
                                enableShowHideButton
                                error={error}
                            />
                            {/* L'œil du champ occupe déjà le coin droit : pas de
                                cadenas ici, il se chevaucherait. */}
                        </div>

                        {error ? (
                            <p className='register-error'>{error}</p>
                        ) : (
                            <p className='register-hint'>{MIN_PASSWORD} caractères minimum</p>
                        )}

                        <button className='submit' type='submit' disabled={collapsing}>
                            Créer le compte
                        </button>
                    </div>
                </div>
            </form>
        </div>
    );
}
