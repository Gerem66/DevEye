import { useEffect, useState } from 'react';
import {
    signupCompleteRequestSchema,
    signupCompleteResponseSchema,
    signupVerifyResponseSchema,
    type SignupVerifyResponse
} from '@deveye/types';

import { post } from '@/api/http';
import TextInput from '@/Components/TextInput';
import { useAuth } from '@/auth/AuthProvider';
import { whenHomeReady } from '@/stores/homeReady';
import { setSignupPlan } from '@/stores/signupPlan';
import { humanizeSignupError } from './errors';
import { LoginScene } from '@/Pages/Login/Scene';

/** Effondrement de la carte puis remplissage : doit rester égal à la somme des
 *  timings de `Login/style.css` (0,3 s de délai + 1 s de balayage). */
const PROGRESS_MS = 1300;
/** Le fondu de la scène entière, celui de `.login.hide`. */
const FADE_MS = 500;
/** Plafond d'attente de l'accueil au-delà de la barre : un premier chargement
 *  en panne ne doit pas coincer l'inscrit sur cet écran. */
const HOME_READY_MAX_MS = 4000;

const MIN_PASSWORD = 8;

/** Étape 3, ouverte depuis le mail : le mot de passe, puis le compte naît. */
export function SignupVerify({
    token,
    onDone,
    onRestart
}: {
    token: string;
    onDone: () => void;
    onRestart: () => void;
}) {
    const { refresh } = useAuth();
    const [who, setWho] = useState<SignupVerifyResponse | null>(null);
    const [dead, setDead] = useState(false);
    const [password, setPassword] = useState('');
    const [confirm, setConfirm] = useState('');
    const [error, setError] = useState('');
    const [collapsing, setCollapsing] = useState(false);
    const [hidden, setHidden] = useState(false);

    useEffect(() => {
        post('/api/auth/signup/verify', { token }, signupVerifyResponseSchema)
            .then(setWho)
            .catch(() => setDead(true));
    }, [token]);

    const submit = (): void => {
        if (collapsing || !who) return;
        if (password.length < MIN_PASSWORD) return setError(`Le mot de passe fait ${MIN_PASSWORD} caractères minimum`);
        if (password !== confirm) return setError('Les mots de passe ne correspondent pas');
        const parsed = signupCompleteRequestSchema.safeParse({ token, password });
        if (!parsed.success) return setError('Vérifiez les informations saisies');

        setError('');
        setCollapsing(true);
        const startedAt = Date.now();
        void (async () => {
            try {
                const { signupPlan } = await post(
                    '/api/auth/signup/complete',
                    parsed.data,
                    signupCompleteResponseSchema
                );
                setSignupPlan(signupPlan);
                // La session s'ouvre et l'accueil se monte dessous. La barre finit
                // sa course, l'accueil reçoit ses données, puis la scène s'efface :
                // aucun autre écran ne doit se voir entre les deux.
                await refresh();
                const remaining = PROGRESS_MS - (Date.now() - startedAt);
                if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
                await whenHomeReady(HOME_READY_MAX_MS);
                setHidden(true);
                setTimeout(onDone, FADE_MS);
            } catch (e) {
                setError(humanizeSignupError(e));
                setCollapsing(false);
            }
        })();
    };

    if (dead) {
        return (
            <LoginScene>
                <p className='signup-intro'>Ce lien est invalide ou a expiré.</p>
                <button type='button' className='submit' onClick={onRestart}>
                    Recommencer l’inscription
                </button>
            </LoginScene>
        );
    }

    return (
        <LoginScene collapsing={collapsing} hidden={hidden} onSubmit={submit}>
            <p className='signup-intro'>
                {who ? (
                    <>
                        Bonjour <b>{who.username}</b>, choisissez votre mot de passe.
                    </>
                ) : (
                    'Vérification du lien…'
                )}
            </p>

            <div className='input-group'>
                <TextInput
                    type='password'
                    placeholder='Mot de passe'
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete='new-password'
                    enableShowHideButton
                    disabled={!who}
                    autoFocus
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
                    error={error}
                />
            </div>

            <p className={error ? 'signup-error' : 'signup-hint'}>{error || `${MIN_PASSWORD} caractères minimum`}</p>

            <button className='submit' type='submit' disabled={collapsing || !who}>
                Créer le compte
            </button>
        </LoginScene>
    );
}
