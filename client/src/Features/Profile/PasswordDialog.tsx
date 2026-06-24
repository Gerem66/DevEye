import { useState } from 'react';

import { ApiError, changePassword } from '@/api/http';
import { Dialog } from '@/Components/Dialog';
import { TextInput } from '@/Components';
import Button from '@/Components/Button';

import styles from './style.module.css';

interface PasswordDialogProps {
    open: boolean;
    onClose: () => void;
}

const MIN_LENGTH = 8;

function humanizeError(err: unknown): string {
    if (err instanceof ApiError) {
        switch (err.code) {
            case 'auth_invalid':
                return 'Mot de passe actuel incorrect.';
            case 'validation':
                return "Le nouveau mot de passe est invalide ou identique à l'actuel.";
            case 'auth_required':
            case 'auth_expired':
                return 'Session expirée, reconnectez-vous.';
            case 'rate_limited':
                return 'Trop de tentatives, réessayez plus tard.';
            case 'network':
                return 'Serveur injoignable.';
            default:
                return err.message || 'Une erreur est survenue.';
        }
    }
    return 'Une erreur est survenue.';
}

export function PasswordDialog({ open, onClose }: PasswordDialogProps) {
    const [current, setCurrent] = useState('');
    const [next, setNext] = useState('');
    const [confirm, setConfirm] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [done, setDone] = useState(false);

    const reset = () => {
        setCurrent('');
        setNext('');
        setConfirm('');
        setError(null);
        setLoading(false);
        setDone(false);
    };

    const close = () => {
        reset();
        onClose();
    };

    const onSubmit = async () => {
        if (loading) return;
        if (!current || !next || !confirm) {
            setError('Tous les champs sont requis.');
            return;
        }
        if (next.length < MIN_LENGTH) {
            setError(`Le nouveau mot de passe doit contenir au moins ${MIN_LENGTH} caractères.`);
            return;
        }
        if (next !== confirm) {
            setError('La confirmation ne correspond pas.');
            return;
        }
        if (next === current) {
            setError("Le nouveau mot de passe doit être différent de l'actuel.");
            return;
        }

        setError(null);
        setLoading(true);
        try {
            await changePassword({ currentPassword: current, newPassword: next });
            setDone(true);
        } catch (err) {
            setError(humanizeError(err));
        } finally {
            setLoading(false);
        }
    };

    return (
        <Dialog
            open={open}
            onClose={close}
            title='Modifier le mot de passe'
            onSubmit={() => (done ? close() : void onSubmit())}
            footer={
                done ? (
                    <Button onClick={close}>Fermer</Button>
                ) : (
                    <>
                        <Button variant='secondary' onClick={close} disabled={loading}>
                            Annuler
                        </Button>
                        <Button onClick={() => void onSubmit()} disabled={loading}>
                            {loading ? 'Enregistrement…' : 'Enregistrer'}
                        </Button>
                    </>
                )
            }
        >
            {done ? (
                <p className={styles.formSuccess}>Votre mot de passe a été modifié.</p>
            ) : (
                <div className={styles.form}>
                    <label className={styles.field}>
                        <span className={styles.fieldLabel}>Mot de passe actuel</span>
                        <TextInput
                            type='password'
                            enableShowHideButton
                            autoComplete='current-password'
                            value={current}
                            onChange={(e) => setCurrent(e.target.value)}
                        />
                    </label>
                    <label className={styles.field}>
                        <span className={styles.fieldLabel}>Nouveau mot de passe</span>
                        <TextInput
                            type='password'
                            enableShowHideButton
                            autoComplete='new-password'
                            value={next}
                            onChange={(e) => setNext(e.target.value)}
                        />
                    </label>
                    <label className={styles.field}>
                        <span className={styles.fieldLabel}>Confirmer le nouveau mot de passe</span>
                        <TextInput
                            type='password'
                            enableShowHideButton
                            autoComplete='new-password'
                            value={confirm}
                            onChange={(e) => setConfirm(e.target.value)}
                        />
                    </label>
                    {error && <p className={styles.formError}>{error}</p>}
                </div>
            )}
        </Dialog>
    );
}
