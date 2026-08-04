import { useState } from 'react';

import Popup, { ClosePopup } from '@/Components/Popup';
import Button from '@/Components/Button';
import TextInput from '@/Components/TextInput';
import { ws, WsError } from '@/api/ws';

import styles from './style.module.css';

import type { Workspace } from 'deveye-types';

interface PopupUnlockProps {
    workspace: Workspace | null;
}

function PopupUnlock({ workspace }: PopupUnlockProps) {
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
            await ws.send('password.unlock', { password });
            reset();
            ClosePopup('popup-unlock', true);
        } catch (e) {
            setError(e instanceof WsError ? humanizeUnlockError(e) : 'Erreur inconnue');
            setPassword('');
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Popup id='popup-unlock' title='Déverrouiller' onClosePopup={close} onSubmit={submit}>
            <p className={styles.popupHint}>
                Cet espace de travail est protégé. Saisissez son mot de passe pour y accéder.
            </p>

            <TextInput
                type='password'
                placeholder='Mot de passe de l’espace de travail'
                value={password}
                error={error}
                onChange={(e) => setPassword(e.target.value)}
                enableShowHideButton
            />

            <div className={styles.popupActions}>
                <Button variant='secondary' onClick={close}>
                    Fermer
                </Button>
                <Button onClick={submit} disabled={submitting}>
                    {submitting ? '…' : 'Déverrouiller'}
                </Button>
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
