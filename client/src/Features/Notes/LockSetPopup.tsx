import { useState } from 'react';

import styles from './style.module.css';

import Popup, { ClosePopup } from '@/Components/Popup';
import Button from '@/Components/Button';
import TextInput from '@/Components/TextInput';

export const NOTE_LOCK_SET_POPUP = 'popup-note-lock-set';

/**
 * Define or change a note's dedicated password, in its own popup (over the
 * editor) rather than crowding the editor surface. Opening it already proves the
 * user is authorized (the note was unlocked, or it's a new note), so no current
 * password is asked here. Resolves OpenPopup with the chosen password, or `null`
 * on cancel. The caller stores it as a pending `{ set }` lock change.
 */
export interface NoteLockSetInput {
    /** True when the note already has a lock (wording: "nouveau" mot de passe). */
    changing?: boolean;
}

export default function LockSetPopup() {
    const [changing, setChanging] = useState(false);
    const [password, setPassword] = useState('');
    const [confirm, setConfirm] = useState('');
    const [error, setError] = useState('');

    function reset() {
        setPassword('');
        setConfirm('');
        setError('');
    }

    function handleOpen(input: NoteLockSetInput) {
        setChanging(input?.changing ?? false);
        reset();
    }

    function close(result: string | null) {
        reset();
        ClosePopup(NOTE_LOCK_SET_POPUP, result);
    }

    function submit() {
        if (password.trim().length === 0) {
            setError('Choisissez un mot de passe pour cette note');
            return;
        }
        if (password !== confirm) {
            setError('Les mots de passe ne correspondent pas');
            return;
        }
        close(password);
    }

    return (
        <Popup<NoteLockSetInput>
            id={NOTE_LOCK_SET_POPUP}
            title={changing ? 'Changer le mot de passe' : 'Verrouiller la note'}
            width={420}
            onInputChange={handleOpen}
            onClosePopup={() => close(null)}
            onSubmit={submit}
        >
            <p className={styles.popupHint}>
                {changing
                    ? 'Définissez un nouveau mot de passe dédié à cette note.'
                    : 'Cette note sera protégée par son propre mot de passe, distinct de celui de votre compte.'}
            </p>
            <TextInput
                type='password'
                enableShowHideButton
                autoComplete='new-password'
                placeholder='Mot de passe de la note'
                value={password}
                error={error}
                onChange={(e) => {
                    setPassword(e.target.value);
                    if (error) setError('');
                }}
            />
            <div style={{ marginTop: 'var(--space-sm)' }}>
                <TextInput
                    type='password'
                    enableShowHideButton
                    autoComplete='new-password'
                    placeholder='Confirmer le mot de passe'
                    value={confirm}
                    onChange={(e) => {
                        setConfirm(e.target.value);
                        if (error) setError('');
                    }}
                />
            </div>
            <div className={styles.editorFooter} style={{ marginTop: 'var(--space-md)' }}>
                <span />
                <div className={styles.footerRight}>
                    <Button variant='secondary' onClick={() => close(null)}>
                        Annuler
                    </Button>
                    <Button onClick={submit}>{changing ? 'Changer' : 'Verrouiller'}</Button>
                </div>
            </div>
        </Popup>
    );
}
