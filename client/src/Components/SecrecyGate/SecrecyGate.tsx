import { useState } from 'react';

import { ws, WsError } from '@/api/ws';
import { Dialog } from '@/Components/Dialog';
import { TextInput } from '@/Components';
import Button from '@/Components/Button';
import { cancelUnlock, resolveUnlock, useSecrecy } from '@/stores/secrecy';

/**
 * App-level prompt for password-based encryption. Mounted once; opens whenever
 * a feature calls `ensureUnlocked()` (typically after a `locked` error). On
 * success the session DEK is held server-side for the rest of the connection.
 */
export default function SecrecyGate() {
    const { prompting } = useSecrecy();
    const [password, setPassword] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    const reset = () => {
        setPassword('');
        setError(null);
        setLoading(false);
    };

    const onCancel = () => {
        reset();
        cancelUnlock();
    };

    const onSubmit = async () => {
        if (loading) return;
        if (!password) {
            setError('Mot de passe requis');
            return;
        }
        setLoading(true);
        setError(null);
        try {
            await ws.send('secrecy.unlock', { password });
            reset();
            resolveUnlock();
        } catch (e) {
            setError(e instanceof WsError && e.code === 'auth_invalid' ? 'Mot de passe incorrect' : 'Erreur inconnue');
            setPassword('');
        } finally {
            setLoading(false);
        }
    };

    const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'Enter') void onSubmit();
    };

    return (
        <Dialog
            open={prompting}
            onClose={onCancel}
            title='Déverrouiller vos données'
            description='Le chiffrement par mot de passe est activé. Saisissez votre mot de passe pour accéder à vos données chiffrées.'
            footer={
                <>
                    <Button variant='secondary' onClick={onCancel} disabled={loading}>
                        Annuler
                    </Button>
                    <Button onClick={() => void onSubmit()} disabled={loading}>
                        {loading ? 'Déverrouillage…' : 'Déverrouiller'}
                    </Button>
                </>
            }
        >
            <div onKeyDown={onKeyDown}>
                <TextInput
                    type='password'
                    enableShowHideButton
                    autoComplete='current-password'
                    placeholder='Mot de passe'
                    value={password}
                    error={error ?? undefined}
                    onChange={(e) => setPassword(e.target.value)}
                />
            </div>
        </Dialog>
    );
}
