import { useState } from 'react';

import { ws, WsError } from '@/api/ws';
import { Dialog } from '@/Components/Dialog';
import { TextInput } from '@/Components';
import Button from '@/Components/Button';
import { cancelUnlock, resolveUnlock, useSecrecy, useUnlockTarget } from '@/stores/secrecy';

/**
 * App-level prompt for password-based encryption. Mounted once; opens whenever
 * a feature calls `ensureUnlocked()` (typically after a `locked` error). On
 * success the session DEK is held server-side for the rest of the connection.
 */
export default function SecrecyGate() {
    const { prompting } = useSecrecy();
    const promptFor = useUnlockTarget();
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
            // Le coffre d'une autre instance s'ouvre sur SA socket : le mot de
            // passe est celui du compte de là-bas, et ne passe que par elle.
            const conn = promptFor ? ws.connectionFor(promptFor.instanceId) : ws;
            if (!conn) throw new WsError('closed', 'Instance distante déconnectée');
            await conn.send('secrecy.unlock', { password });
            reset();
            resolveUnlock();
        } catch (e) {
            setError(e instanceof WsError && e.code === 'auth_invalid' ? 'Mot de passe incorrect' : 'Erreur inconnue');
            setPassword('');
        } finally {
            setLoading(false);
        }
    };

    return (
        <Dialog
            open={prompting}
            onClose={onCancel}
            title={promptFor ? `Déverrouiller ${promptFor.label}` : 'Déverrouiller vos données'}
            description={
                promptFor
                    ? `Le chiffrement par mot de passe est activé sur ${promptFor.label}. Saisissez le mot de passe de votre compte là-bas.`
                    : 'Le chiffrement par mot de passe est activé. Saisissez votre mot de passe pour accéder à vos données chiffrées.'
            }
            onSubmit={() => void onSubmit()}
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
            <TextInput
                type='password'
                enableShowHideButton
                autoComplete='current-password'
                placeholder='Mot de passe'
                value={password}
                error={error ?? undefined}
                onChange={(e) => setPassword(e.target.value)}
            />
        </Dialog>
    );
}
