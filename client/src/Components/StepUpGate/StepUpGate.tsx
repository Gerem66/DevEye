import { useState } from 'react';

import { WsError } from '@/api/ws';
import Button from '@/Components/Button';
import { AuthenticatorCodeField, authenticatorCodeReady } from '@/Components/CodeInput';
import { Dialog } from '@/Components/Dialog';
import { cancelStepUp, resolveStepUp, useStepUpPrompt } from '@/stores/stepUp';
import { requestOpenView } from '@/stores/viewRequest';

/**
 * L'invite du code d'application avant de piloter une machine. Montée une fois ;
 * s'ouvre quand un ordre revient `stepup_required` (voir `api/ws.ts`), qui
 * repart dès le code confirmé. Sans application d'authentification, elle dit
 * où l'ajouter.
 */
export default function StepUpGate() {
    const prompt = useStepUpPrompt();
    const [code, setCode] = useState('');
    const [recovery, setRecovery] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    const reset = () => {
        setCode('');
        setRecovery(false);
        setError(null);
        setLoading(false);
    };

    const onCancel = () => {
        reset();
        cancelStepUp();
    };

    const submit = async (value: string) => {
        if (!prompt || loading || !authenticatorCodeReady(value, recovery)) return;
        setLoading(true);
        setError(null);
        try {
            await prompt.confirm(value);
            reset();
            resolveStepUp();
        } catch (e) {
            setError(
                e instanceof WsError && e.code === 'auth_invalid'
                    ? 'Code incorrect.'
                    : e instanceof Error
                      ? e.message
                      : 'Confirmation impossible.'
            );
            setCode('');
            setLoading(false);
        }
    };

    if (prompt && !prompt.twoFactor) {
        return (
            <Dialog
                open
                onClose={onCancel}
                title='Activez la double authentification'
                description='Piloter une machine (terminal, fichiers, mises à jour, conteneurs) demande un code de votre application d’authentification. Activez-la dans Sécurité, puis recommencez.'
                footer={
                    <>
                        <Button variant='secondary' onClick={onCancel}>
                            Fermer
                        </Button>
                        <Button
                            onClick={() => {
                                onCancel();
                                requestOpenView('security');
                            }}
                        >
                            Ouvrir Sécurité
                        </Button>
                    </>
                }
            />
        );
    }

    return (
        <Dialog
            open={prompt !== null}
            onClose={onCancel}
            title='Confirmer avec votre code'
            description={
                recovery
                    ? 'Saisissez l’un de vos codes de secours. Il ne servira qu’une fois.'
                    : 'Piloter une machine demande le code à 6 chiffres de votre application d’authentification.'
            }
            onSubmit={() => void submit(code)}
            footer={
                <>
                    <Button variant='secondary' onClick={onCancel} disabled={loading}>
                        Annuler
                    </Button>
                    <Button
                        onClick={() => void submit(code)}
                        disabled={loading || !authenticatorCodeReady(code, recovery)}
                    >
                        {loading ? 'Vérification…' : 'Confirmer'}
                    </Button>
                </>
            }
        >
            <AuthenticatorCodeField
                value={code}
                recovery={recovery}
                onRecoveryChange={setRecovery}
                error={error}
                autoFocus
                disabled={loading}
                onChange={(value) => {
                    setCode(value);
                    setError(null);
                }}
                onComplete={(value) => void submit(value)}
            />
        </Dialog>
    );
}
