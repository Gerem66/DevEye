import { useRef, useState } from 'react';

import styles from './style.module.css';

import Popup, { ClosePopup } from '@/Components/Popup';
import Button from '@/Components/Button';
import TextInput from '@/Components/TextInput';

export const NOTE_LOCK_POPUP = 'popup-note-lock';

/** Outcome of a password attempt, returned by {@link NoteLockInput.verify}. */
export type LockVerifyResult =
    /** Password accepted — the popup resolves with it and closes. */
    | { ok: true }
    /** Wrong password — the popup stays open and shows an inline error. */
    | { ok: false }
    /** Other failure — the popup closes (resolving null); caller surfaces it. */
    | { ok: false; abort: true };

/**
 * Per-note unlock prompt. A locked note carries its own dedicated password,
 * verified server-side on every open (no session reveal). The popup owns the
 * verify→retry loop: it calls `verify(password)` and, on a wrong password, stays
 * open with an inline error instead of closing and reopening (which looked like a
 * flicker/bug). Resolves OpenPopup with the accepted password, or `null` on
 * cancel / abort.
 */
export interface NoteLockInput {
    /** Wording: opening vs. deleting the note. */
    intent?: 'open' | 'delete';
    /** Validate a candidate password (typically a `note.get`/`note.delete` call). */
    verify: (password: string) => Promise<LockVerifyResult>;
}

const NOOP_VERIFY = async (): Promise<LockVerifyResult> => ({ ok: false, abort: true });

export default function LockPopup() {
    const inputRef = useRef<HTMLInputElement | null>(null);
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [intent, setIntent] = useState<'open' | 'delete'>('open');
    const verifyRef = useRef<(password: string) => Promise<LockVerifyResult>>(NOOP_VERIFY);

    function handleOpen(input: NoteLockInput) {
        setIntent(input?.intent ?? 'open');
        verifyRef.current = input?.verify ?? NOOP_VERIFY;
        setPassword('');
        setError('');
        setSubmitting(false);
        setTimeout(() => inputRef.current?.focus(), 0);
    }

    function close(result: string | null) {
        setPassword('');
        setError('');
        setSubmitting(false);
        ClosePopup(NOTE_LOCK_POPUP, result);
    }

    async function submit() {
        if (submitting) return;
        if (!password) {
            setError('Mot de passe requis');
            return;
        }
        setSubmitting(true);
        setError('');
        const result = await verifyRef.current(password);
        if (result.ok) {
            close(password);
            return;
        }
        if ('abort' in result && result.abort) {
            close(null);
            return;
        }
        // Wrong password: keep the popup open, show the error, let the user retry.
        setError('Mot de passe incorrect');
        setPassword('');
        setSubmitting(false);
        setTimeout(() => inputRef.current?.focus(), 0);
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
                onChange={(e) => {
                    setPassword(e.target.value);
                    if (error) setError('');
                }}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') void submit();
                }}
            />
            <div className={styles.editorFooter} style={{ marginTop: 'var(--space-md)' }}>
                <span />
                <div className={styles.footerRight}>
                    <Button variant='secondary' onClick={() => close(null)} disabled={submitting}>
                        Annuler
                    </Button>
                    <Button onClick={() => void submit()} disabled={submitting}>
                        {submitting ? '…' : intent === 'delete' ? 'Supprimer' : 'Ouvrir'}
                    </Button>
                </div>
            </div>
        </Popup>
    );
}
