import { useState } from 'react';

import { humanizeError } from '@/api/useResource';
import { ws } from '@/api/ws';
import { useAuth } from '@/auth/AuthProvider';
import { Dialog } from '@/Components/Dialog';
import { TextInput } from '@/Components';
import Button from '@/Components/Button';

import styles from './style.module.css';

interface UsernameDialogProps {
    open: boolean;
    onClose: () => void;
}

/** Même borne que le contrat (`usernameSchema`) : la saisie s'arrête avant le refus. */
const MAX_LENGTH = 64;
const MIN_LENGTH = 3;

/** La règle du contrat, dite en français : le schéma ne parle qu'anglais. */
const RULE = 'Lettres, chiffres, point, tiret et souligné, de 3 à 64 caractères.';

export function UsernameDialog({ open, onClose }: UsernameDialogProps) {
    const { user, updateUser } = useAuth();
    const current = user?.username ?? '';
    const [next, setNext] = useState(current);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [done, setDone] = useState<string | null>(null);

    const close = () => {
        setNext(current);
        setError(null);
        setLoading(false);
        setDone(null);
        onClose();
    };

    const onSubmit = async () => {
        if (loading) return;
        const username = next.trim();
        if (!username) {
            setError('Le pseudo est requis.');
            return;
        }
        if (username === current) {
            setError('Ce pseudo est déjà le vôtre.');
            return;
        }
        if (username.length < MIN_LENGTH) {
            setError(RULE);
            return;
        }

        setError(null);
        setLoading(true);
        try {
            const res = await ws.send('user.setUsername', { username });
            updateUser({ username: res.username });
            setDone(res.username);
        } catch (err) {
            // Un pseudo déjà pris est refusé par le serveur, qui porte sa
            // phrase ; le rejet local par le schéma n'en a pas, d'où la règle.
            setError(humanizeError(err, RULE));
        } finally {
            setLoading(false);
        }
    };

    return (
        <Dialog
            open={open}
            onClose={close}
            title='Modifier le pseudo'
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
                <p className={styles.formSuccess}>Vous êtes désormais « {done} ».</p>
            ) : (
                <div className={styles.form}>
                    <label className={styles.field}>
                        <span className={styles.fieldLabel}>Nouveau pseudo</span>
                        <TextInput
                            autoComplete='username'
                            maxLength={MAX_LENGTH}
                            value={next}
                            onChange={(e) => setNext(e.target.value)}
                        />
                        <span className={styles.fieldHint}>C’est aussi votre identifiant de connexion.</span>
                    </label>
                    {error && <p className={styles.formError}>{error}</p>}
                </div>
            )}
        </Dialog>
    );
}
