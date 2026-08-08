import { useState } from 'react';

import { ws, WsError } from '@/api/ws';
import { Dialog } from '@/Components/Dialog';
import { Checkbox, TextInput } from '@/Components';
import Button from '@/Components/Button';
import { setUnlocked } from '@/stores/secrecy';

import styles from './Security.module.css';

interface SecurityDialogProps {
    open: boolean;
    /** Whether password-based encryption is currently enabled. */
    enabled: boolean;
    onClose: () => void;
    /** Called after a successful enable/disable so the parent can refresh. */
    onChanged: () => void;
}

type Mode = 'enable' | 'disable' | 'showRecovery';

function humanize(e: unknown, fallback: string): string {
    if (e instanceof WsError) {
        if (e.code === 'auth_invalid') return 'Mot de passe incorrect.';
        if (e.code === 'conflict') return e.message;
    }
    return fallback;
}

/**
 * Manage password-based encryption from the profile: turn it on (optionally
 * generating a recovery code shown once) or off. Disabling re-wraps the data
 * with the server key; the encrypted content itself is never rewritten.
 */
export function SecurityDialog({ open, enabled, onClose, onChanged }: SecurityDialogProps) {
    const [password, setPassword] = useState('');
    const [wantRecovery, setWantRecovery] = useState(true);
    const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    const mode: Mode = recoveryCode ? 'showRecovery' : enabled ? 'disable' : 'enable';

    const reset = () => {
        setPassword('');
        setWantRecovery(true);
        setRecoveryCode(null);
        setError(null);
        setLoading(false);
    };

    const close = () => {
        reset();
        onClose();
    };

    const onEnable = async () => {
        if (loading) return;
        if (!password) return setError('Mot de passe requis.');
        setLoading(true);
        setError(null);
        try {
            const res = await ws.send('secrecy.enable', { password, recovery: wantRecovery });
            setUnlocked(true);
            onChanged();
            if (res.recoveryCode) {
                setPassword('');
                setRecoveryCode(res.recoveryCode);
            } else {
                close();
            }
        } catch (e) {
            setError(humanize(e, "Échec de l'activation."));
        } finally {
            setLoading(false);
        }
    };

    const onDisable = async () => {
        if (loading) return;
        if (!password) return setError('Mot de passe requis.');
        setLoading(true);
        setError(null);
        try {
            await ws.send('secrecy.disable', { password });
            setUnlocked(true);
            onChanged();
            close();
        } catch (e) {
            setError(humanize(e, 'Échec de la désactivation.'));
        } finally {
            setLoading(false);
        }
    };

    if (mode === 'showRecovery') {
        return (
            <Dialog
                open={open}
                onClose={close}
                title='Code de récupération'
                onSubmit={close}
                description='⚠️ Conservez ce code en lieu sûr. Il permet de récupérer vos données si vous oubliez votre mot de passe, et ne sera plus affiché.'
                footer={
                    <>
                        <Button
                            variant='secondary'
                            onClick={() => void navigator.clipboard.writeText(recoveryCode ?? '')}
                        >
                            Copier
                        </Button>
                        <Button onClick={close}>J&apos;ai sauvegardé mon code</Button>
                    </>
                }
            >
                <code className={styles.recoveryCodeBox}>{recoveryCode}</code>
            </Dialog>
        );
    }

    if (mode === 'disable') {
        return (
            <Dialog
                open={open}
                onClose={close}
                title='Désactiver le chiffrement par mot de passe'
                description='Vos données seront de nouveau protégées par la clé du serveur uniquement. Saisissez votre mot de passe pour confirmer.'
                onSubmit={() => void onDisable()}
                footer={
                    <>
                        <Button variant='secondary' onClick={close} disabled={loading}>
                            Annuler
                        </Button>
                        <Button variant='danger' onClick={() => void onDisable()} disabled={loading}>
                            {loading ? 'Désactivation…' : 'Désactiver'}
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

    return (
        <Dialog
            open={open}
            onClose={close}
            title='Activer le chiffrement par mot de passe'
            description='Vos données chiffrées seront verrouillées par votre mot de passe. Même en cas de vol de la base, elles resteront illisibles sans celui-ci.'
            onSubmit={() => void onEnable()}
            footer={
                <>
                    <Button variant='secondary' onClick={close} disabled={loading}>
                        Annuler
                    </Button>
                    <Button onClick={() => void onEnable()} disabled={loading}>
                        {loading ? 'Activation…' : 'Activer'}
                    </Button>
                </>
            }
        >
            <div className={styles.form}>
                <label className={styles.field}>
                    <span className={styles.fieldLabel}>Mot de passe</span>
                    <TextInput
                        type='password'
                        enableShowHideButton
                        autoComplete='current-password'
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                    />
                </label>
                <Checkbox checked={wantRecovery} onChange={setWantRecovery}>
                    Générer un code de récupération (si vous oubliez votre mot de passe, vos données seront
                    irrécupérables sans ce code)
                </Checkbox>
                {error && <p className={styles.formError}>{error}</p>}
            </div>
        </Dialog>
    );
}
