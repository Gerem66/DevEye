import { useEffect, useRef, useState } from 'react';

import { ApiError } from '../../api/http';
import { useAuth } from '../../auth/AuthProvider';
import { TextInput } from '../../Components';
import { Sleep } from '../../Utils/Functions';
import './style.css';

function LoginPage() {
    const { status, login } = useAuth();
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);

    const cardRef = useRef<HTMLDivElement | null>(null);
    const inputUsername = useRef<HTMLInputElement | null>(null);
    const inputPassword = useRef<HTMLInputElement | null>(null);

    const show = status !== 'authenticated';

    useEffect(() => {
        if (status === 'unknown') {
            cardRef.current?.classList.add('card-to-progressbar', 'auto-login');
        } else {
            cardRef.current?.classList.remove('card-to-progressbar', 'auto-login');
        }
    }, [status]);

    const startAnim = () => {
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
            await login(username, password);
            const elapsed = Date.now() - startedAt;
            if (elapsed < 1500) await Sleep(1500 - elapsed);
            setPassword('');
        } catch (e) {
            const elapsed = Date.now() - startedAt;
            if (elapsed < 800) await Sleep(800 - elapsed);
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

    const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'Enter') void onSubmit();
    };

    return (
        <div className={'login' + (show ? '' : ' hide')}>
            <div className='form'>
                <span className='title'>
                    <b>Dev</b> <p>Eye</p>
                </span>

                <div ref={cardRef} className='login-card' onKeyDown={onKeyDown}>
                    <div className='progress-bar' />

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
