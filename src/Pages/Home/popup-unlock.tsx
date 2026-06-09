import { useRef, useState } from 'react';

import { Button, TextInput } from '@/Components';
import Popup, { ClosePopup } from '@/Components/Popup';
import { ws, WsError } from '@/api/ws';

import styles from './style.module.css';

import type { Workspace } from 'deveye-types';

interface PopupUnlockProps {
    workspace: Workspace | null;
}

function PopupUnlock({ workspace }: PopupUnlockProps) {
    const inputRef = useRef<HTMLInputElement | null>(null);
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [submitting, setSubmitting] = useState(false);

    const reset = () => {
        setPassword('');
        setError('');
    };

    const close = () => {
        reset();
        ClosePopup('popup-unlock');
    };

    const submit = async () => {
        if (!workspace) {
            setError('Workspace introuvable');
            return;
        }
        if (!password) {
            setError('Mot de passe vide');
            return;
        }
        if (submitting) return;
        setSubmitting(true);
        setError('');
        try {
            await ws.send('password.unlock', { workspaceId: workspace.id, password });
            reset();
            ClosePopup('popup-unlock', true);
        } catch (e) {
            setError(e instanceof WsError ? humanizeUnlockError(e) : 'Erreur inconnue');
            setPassword('');
        } finally {
            setSubmitting(false);
        }
    };

    const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') void submit();
    };

    return (
        <Popup
            id='popup-unlock'
            title='Déverrouiller'
            onInputChange={() => inputRef.current?.focus()}
            onClosePopup={close}
        >
            <p>Pour accéder à vos mots de passe, veuillez entrer votre mot de passe principal.</p>

            <div className='form-group'>
                <TextInput
                    ref={inputRef}
                    type='password'
                    placeholder='Mot de passe principal'
                    value={password}
                    error={error}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={onKeyDown}
                    enableShowHideButton
                />
            </div>

            <div className={`form-group ${styles['popup-check-password-buttons']}`}>
                <Button onClick={close} color='#576d8c'>
                    Fermer
                </Button>
                <Button onClick={submit}>{submitting ? '…' : 'Déverrouiller'}</Button>
            </div>
        </Popup>
    );
}

function humanizeUnlockError(err: WsError): string {
    switch (err.code) {
        case 'auth_invalid':
            return 'Mot de passe incorrect';
        case 'not_found':
            return 'Workspace introuvable';
        case 'forbidden':
            return 'Accès refusé';
        case 'timeout':
            return 'Délai dépassé';
        case 'closed':
            return 'Connexion perdue';
        default:
            return err.message || 'Erreur inconnue';
    }
}

export default PopupUnlock;
