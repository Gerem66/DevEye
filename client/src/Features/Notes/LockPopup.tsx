import { useRef, useState } from 'react';

import styles from './style.module.css';

import Popup, { ClosePopup } from '@/Components/Popup';
import Button from '@/Components/Button';
import TextInput from '@/Components/TextInput';

export const NOTE_LOCK_POPUP = 'popup-note-lock';

/**
 * Per-note unlock prompt. A locked note carries its own dedicated password,
 * verified server-side on every open (no session reveal). Resolves OpenPopup
 * with the typed password on confirm, or `null` on cancel. The caller passes
 * the password to `note.get`/`note.delete`/`note.edit`; if the server rejects
 * it (`auth_invalid`), the caller reopens this popup.
 */
export interface NoteLockInput {
    /** Optional message override (e.g. "Saisissez le mot de passe pour supprimer…"). */
    intent?: 'open' | 'delete';
    /** Shown when a previous attempt was wrong, to prompt a retry. */
    error?: string;
}

export default function LockPopup() {
    const inputRef = useRef<HTMLInputElement | null>(null);
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [intent, setIntent] = useState<'open' | 'delete'>('open');

    function reset() {
        setPassword('');
        setError('');
    }

    function handleOpen(input: NoteLockInput) {
        setIntent(input?.intent ?? 'open');
        setPassword('');
        setError(input?.error ?? '');
        setTimeout(() => inputRef.current?.focus(), 0);
    }

    function close(result: string | null) {
        reset();
        ClosePopup(NOTE_LOCK_POPUP, result);
    }

    function submit() {
        if (!password) {
            setError('Mot de passe requis');
            return;
        }
        close(password);
    }

    return (
        <Popup<NoteLockInput>
            id={NOTE_LOCK_POPUP}
            title='Note verrouillée'
            onInputChange={handleOpen}
            onClosePopup={() => close(null)}
        >
            <p className={styles.popupHint}>
                {intent === 'delete'
                    ? 'Saisissez le mot de passe de cette note pour la supprimer.'
                    : 'Cette note est protégée. Saisissez son mot de passe pour l’ouvrir.'}
            </p>
            <TextInput
                ref={inputRef}
                type='password'
                enableShowHideButton
                autoComplete='off'
                placeholder='Mot de passe de la note'
                value={password}
                error={error}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') submit();
                }}
            />
            <div className={styles.editorFooter} style={{ marginTop: 'var(--space-md)' }}>
                <span />
                <div className={styles.footerRight}>
                    <Button variant='secondary' onClick={() => close(null)}>
                        Annuler
                    </Button>
                    <Button onClick={submit}>{intent === 'delete' ? 'Supprimer' : 'Ouvrir'}</Button>
                </div>
            </div>
        </Popup>
    );
}
