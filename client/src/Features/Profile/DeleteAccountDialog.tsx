import { useState } from 'react';

import { humanizeError } from '@/api/useResource';
import { ws, WsError } from '@/api/ws';
import { useAuth } from '@/auth/AuthProvider';
import { Dialog } from '@/Components/Dialog';
import { TextInput } from '@/Components';
import Button from '@/Components/Button';

import styles from './style.module.css';

interface DeleteAccountDialogProps {
    open: boolean;
    onClose: () => void;
}

const FALLBACK = 'La suppression a échoué.';

function humanize(err: unknown): string {
    if (err instanceof WsError && err.code === 'auth_invalid') return 'Mot de passe incorrect.';
    return humanizeError(err, FALLBACK);
}

/** La fin du compte : le mot de passe redit, puis plus rien à fermer, le serveur a déjà tout coupé. */
export function DeleteAccountDialog({ open, onClose }: DeleteAccountDialogProps) {
    const { logout } = useAuth();
    const [password, setPassword] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    const close = () => {
        if (loading) return;
        setPassword('');
        setError(null);
        onClose();
    };

    const onSubmit = async () => {
        if (loading) return;
        if (!password) {
            setError('Le mot de passe est requis.');
            return;
        }
        setError(null);
        setLoading(true);
        try {
            await ws.send('user.deleteAccount', { password });
            await logout();
        } catch (err) {
            setError(humanize(err));
            setLoading(false);
        }
    };

    return (
        <Dialog
            open={open}
            onClose={close}
            title='Supprimer mon compte'
            onSubmit={() => void onSubmit()}
            footer={
                <>
                    <Button variant='secondary' onClick={close} disabled={loading}>
                        Annuler
                    </Button>
                    <Button variant='danger' onClick={() => void onSubmit()} disabled={loading}>
                        {loading ? 'Suppression…' : 'Supprimer définitivement'}
                    </Button>
                </>
            }
        >
            <div className={styles.form}>
                <p className={styles.hint}>
                    Votre compte, votre espace personnel, les espaces partagés dont vous êtes propriétaire et tout ce
                    qu’ils contiennent seront supprimés. Un abonnement en cours est résilié immédiatement, sans
                    remboursement de la période entamée. Cette action est irréversible.
                </p>
                <label className={styles.field}>
                    <span className={styles.fieldLabel}>Votre mot de passe, pour confirmer</span>
                    <TextInput
                        type='password'
                        enableShowHideButton
                        autoComplete='current-password'
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                    />
                </label>
                {error && <p className={styles.formError}>{error}</p>}
            </div>
        </Dialog>
    );
}
