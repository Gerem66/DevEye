import { useEffect, useState } from 'react';

import type { LoginChecksStatus } from '@deveye/types';

import { errorNote } from '@/api/useResource';
import { ws, WsError } from '@/api/ws';
import Button from '@/Components/Button';
import { CodeInput, CODE_LENGTH } from '@/Components/CodeInput';
import { Dialog } from '@/Components/Dialog';
import ErrorNote, { type ErrorNoteInput } from '@/Components/ErrorNote';
import TextInput from '@/Components/TextInput';
import styles from './Security.module.css';

interface PhoneDialogProps {
    open: boolean;
    /** Le numéro vérifié, masqué ; `null` sans numéro. */
    current: string | null;
    onClose: () => void;
    onChange: (status: LoginChecksStatus) => void;
}

function noteOf(e: unknown, fallback: string): ErrorNoteInput {
    if (e instanceof WsError && e.code === 'auth_invalid')
        return { message: e.message || 'Mot de passe incorrect', code: e.code };
    return errorNote(e, fallback);
}

/**
 * Le numéro du code par SMS : un code reçu le prouve avant qu'il serve. Le mot
 * de passe est demandé pour l'ajouter, le changer ou le retirer : une session
 * volée ne déplace pas le code vers son propre téléphone.
 */
export function PhoneDialog({ open, current, onClose, onChange }: PhoneDialogProps) {
    const [phone, setPhone] = useState('');
    const [password, setPassword] = useState('');
    const [sentTo, setSentTo] = useState<string | null>(null);
    const [code, setCode] = useState('');
    const [error, setError] = useState<ErrorNoteInput | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (!open) return;
        setPhone('');
        setPassword('');
        setSentTo(null);
        setCode('');
        setError(null);
        setBusy(false);
    }, [open]);

    const start = async () => {
        if (!phone.trim() || !password || busy) return;
        setBusy(true);
        setError(null);
        try {
            const { to } = await ws.send('loginChecks.phoneStart', { phone: phone.trim(), password });
            setPassword('');
            setSentTo(to);
        } catch (e) {
            setPassword('');
            setError(noteOf(e, 'Le code n’a pas pu partir.'));
        } finally {
            setBusy(false);
        }
    };

    const confirm = async (value: string = code) => {
        if (value.length !== CODE_LENGTH || busy) return;
        setBusy(true);
        setError(null);
        try {
            onChange((await ws.send('loginChecks.phoneConfirm', { code: value })).status);
            onClose();
        } catch (e) {
            setCode('');
            if (e instanceof WsError && e.code === 'auth_expired') setSentTo(null);
            setError(
                e instanceof WsError && e.code === 'auth_invalid'
                    ? { message: 'Code incorrect', code: e.code }
                    : noteOf(e, 'Vérification impossible.')
            );
        } finally {
            setBusy(false);
        }
    };

    const remove = async () => {
        if (!password || busy) return;
        setBusy(true);
        setError(null);
        try {
            onChange((await ws.send('loginChecks.phoneRemove', { password })).status);
            onClose();
        } catch (e) {
            setPassword('');
            setError(noteOf(e, 'Le numéro n’a pas pu être retiré.'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title={current ? 'Votre numéro de téléphone' : 'Ajouter un numéro de téléphone'}
            description={
                sentTo
                    ? `Un code à 6 chiffres vient d’être envoyé au ${sentTo}.`
                    : current
                      ? `Le code par SMS part au ${current}. Pour le changer, donnez le nouveau numéro et votre mot de passe.`
                      : 'Un code par SMS confirmera chaque connexion depuis un nouveau navigateur. Il faudra d’abord en recevoir un sur ce numéro.'
            }
            onSubmit={() => void (sentTo ? confirm() : start())}
            footer={
                sentTo ? (
                    <>
                        <Button variant='secondary' onClick={() => setSentTo(null)} disabled={busy}>
                            Retour
                        </Button>
                        <Button onClick={() => void confirm()} disabled={busy || code.length !== CODE_LENGTH}>
                            {busy ? 'Vérification…' : 'Vérifier'}
                        </Button>
                    </>
                ) : (
                    <>
                        {current && (
                            <Button variant='danger' onClick={() => void remove()} disabled={busy || !password}>
                                Retirer ce numéro
                            </Button>
                        )}
                        <Button onClick={() => void start()} disabled={busy || !phone.trim() || !password}>
                            {busy ? 'Envoi…' : 'Recevoir un code'}
                        </Button>
                    </>
                )
            }
        >
            {sentTo ? (
                <div className={styles.phoneCode}>
                    <CodeInput
                        value={code}
                        autoFocus
                        disabled={busy}
                        onChange={(value) => {
                            setCode(value);
                            setError(null);
                        }}
                        onComplete={(value) => void confirm(value)}
                    />
                    <ErrorNote note={error} />
                </div>
            ) : (
                <div className={styles.phoneForm}>
                    <TextInput
                        type='tel'
                        inputMode='tel'
                        autoComplete='tel'
                        placeholder='06 12 34 56 78'
                        value={phone}
                        onChange={(e) => {
                            setPhone(e.target.value);
                            setError(null);
                        }}
                    />
                    <TextInput
                        type='password'
                        enableShowHideButton
                        autoComplete='current-password'
                        placeholder='Mot de passe du compte'
                        value={password}
                        error={error?.code === 'auth_invalid' ? error.message : undefined}
                        onChange={(e) => {
                            setPassword(e.target.value);
                            setError(null);
                        }}
                    />
                    {error?.code !== 'auth_invalid' && <ErrorNote note={error} />}
                </div>
            )}
        </Dialog>
    );
}
