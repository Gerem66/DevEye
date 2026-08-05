import { useState } from 'react';
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

function humanize(e: unknown): string {
    if (!(e instanceof ApiError)) return 'Erreur inconnue';
    if (e.code === 'forbidden') return 'Cette invitation n’est plus valide, ou ne correspond pas à cette adresse.';
    if (e.code === 'conflict') return 'Ce nom d’utilisateur ou cette adresse est déjà pris.';
    if (e.code === 'validation') return 'Vérifiez les informations saisies (3 caractères minimum, mot de passe de 8).';
    return e.message || 'Erreur inconnue';
}

/**
 * Création d'un compte à partir d'une invitation.
 *
 * L'inscription libre n'existe pas : cet écran n'est atteignable que par un lien
 * émis depuis la page Utilisateurs. Une fois créé, le compte est connecté
 * directement — le serveur ouvre la session dans la foulée.
 */
export default function RegisterPage({ token, onDone }: { token: string; onDone: () => void }) {
    const { refresh } = useAuth();
    const [username, setUsername] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);

    const submit = (e: React.FormEvent): void => {
        e.preventDefault();
        if (busy) return;
        const parsed = registerRequestSchema.safeParse({ inviteToken: token, username, email, password });
        if (!parsed.success) {
            setError('Vérifiez les informations saisies (3 caractères minimum, mot de passe de 8).');
            return;
        }
        setBusy(true);
        setError('');
        void (async () => {
            try {
                await post('/api/auth/register', parsed.data, loginResponseSchema);
                // Le serveur a ouvert la session : `refresh` la fait remonter, et
                // l'URL est nettoyée pour qu'un F5 ne repropose pas l'écran.
                await refresh();
                onDone();
            } catch (err) {
                setError(humanize(err));
                setBusy(false);
            }
        })();
    };

    return (
        <div className='login'>
            <form className='form' onSubmit={submit}>
                <h1 className='title'>Créer votre compte</h1>
                <div className='input-group'>
                    <TextInput
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        placeholder='Nom d’utilisateur'
                        aria-label='Nom d’utilisateur'
                        autoComplete='username'
                        maxLength={64}
                    />
                    <TextInput
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder='Adresse email'
                        aria-label='Adresse email'
                        autoComplete='email'
                        maxLength={320}
                    />
                    <TextInput
                        type='password'
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder='Mot de passe (8 caractères minimum)'
                        aria-label='Mot de passe'
                        autoComplete='new-password'
                        enableShowHideButton
                        error={error}
                    />
                </div>
                {error && <p className='twofa-prompt'>{error}</p>}
                <button className='submit' type='submit' disabled={busy}>
                    {busy ? 'Création…' : 'Créer le compte'}
                </button>
            </form>
        </div>
    );
}
