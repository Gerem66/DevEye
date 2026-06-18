import { useRef, useState } from 'react';

import styles from './style.module.css';

import Popup, { ClosePopup } from '@/Components/Popup';
import Button from '@/Components/Button';
import TextInput from '@/Components/TextInput';
import { ws, WsError } from '@/api/ws';

export const NOTE_REVEAL_POPUP = 'popup-note-reveal';

/**
 * "Root auth" gate for hidden notes. Sends the master/account password to
 * `note.reveal`; on success the WS session is authorized to read hidden notes
 * for the rest of the connection. Resolves OpenPopup with `true` when revealed.
 */
export default function RevealPopup() {
    const inputRef = useRef<HTMLInputElement | null>(null);
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [submitting, setSubmitting] = useState(false);

    function reset() {
        setPassword('');
        setError('');
        setSubmitting(false);
    }

    function close(result: boolean) {
        reset();
        ClosePopup(NOTE_REVEAL_POPUP, result);
    }

    async function submit() {
        if (submitting) return;
        if (!password) {
            setError('Mot de passe requis');
            return;
        }
        setSubmitting(true);
        setError('');
        try {
            await ws.send('note.reveal', { password });
            close(true);
        } catch (e) {
            setError(e instanceof WsError && e.code === 'auth_invalid' ? 'Mot de passe incorrect' : 'Erreur inconnue');
            setPassword('');
            setSubmitting(false);
        }
    }

    return (
        <Popup
            id={NOTE_REVEAL_POPUP}
            title='Notes masquées'
            onInputChange={() => {
                reset();
                setTimeout(() => inputRef.current?.focus(), 0);
            }}
            onClosePopup={() => close(false)}
        >
            <p className={styles.popupHint}>Saisissez votre mot de passe principal pour afficher vos notes masquées.</p>
            <TextInput
                ref={inputRef}
                type='password'
                enableShowHideButton
                autoComplete='current-password'
                placeholder='Mot de passe principal'
                value={password}
                error={error}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') void submit();
                }}
            />
            <div className={styles.editorFooter} style={{ marginTop: 'var(--space-md)' }}>
                <span />
                <div className={styles.footerRight}>
                    <Button variant='secondary' onClick={() => close(false)} disabled={submitting}>
                        Annuler
                    </Button>
                    <Button onClick={() => void submit()} disabled={submitting}>
                        {submitting ? 'Déverrouillage…' : 'Afficher'}
                    </Button>
                </div>
            </div>
        </Popup>
    );
}
