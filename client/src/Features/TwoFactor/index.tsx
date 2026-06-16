import { useCallback, useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ws } from '@/api/ws';
import { Dialog } from '@/Components/Dialog';
import Button from '@/Components/Button';
import type { TwoFactorStatus } from 'deveye-types';
import type { FeatureProps } from '../types';
import styles from './TwoFactor.module.css';

export function TwoFactorWidget() {
    const [status, setStatus] = useState<TwoFactorStatus | null>(null);

    useEffect(() => {
        ws.send('twofa.status', {})
            .then((res) => setStatus(res.status))
            .catch(() => {});
    }, []);

    if (!status) {
        return <div className={styles.widgetLoading}>Chargement...</div>;
    }

    return (
        <div className={styles.widgetContent}>
            <div className={`${styles.statusBadge} ${status.enabled ? styles.enabled : styles.disabled}`}>
                <span className='icon icon-shield' />
                <span>{status.enabled ? 'Activé' : 'Désactivé'}</span>
            </div>
            {status.enabled && (
                <div className={styles.backupInfo}>
                    <span className={styles.backupCount}>{status.backupCodesRemaining}</span>
                    <span className={styles.backupLabel}>codes de secours</span>
                </div>
            )}
        </div>
    );
}

interface SetupData {
    secret: string;
    otpauthUrl: string;
    backupCodes: string[];
}

export default function TwoFactor({ user: _user, workspace: _ws }: FeatureProps) {
    const [status, setStatus] = useState<TwoFactorStatus | null>(null);
    const [loading, setLoading] = useState(true);
    const [setupData, setSetupData] = useState<SetupData | null>(null);
    const [verifyCode, setVerifyCode] = useState('');
    const [verifying, setVerifying] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [showBackupCodes, setShowBackupCodes] = useState(false);
    const [backupCodes, setBackupCodes] = useState<string[]>([]);
    const [showDisableConfirm, setShowDisableConfirm] = useState(false);
    const [disableCode, setDisableCode] = useState('');

    const fetchStatus = useCallback(async () => {
        try {
            const res = await ws.send('twofa.status', {});
            setStatus(res.status);
        } catch {
            // ignore
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void fetchStatus();
    }, [fetchStatus]);

    const startSetup = async () => {
        setError(null);
        try {
            const res = await ws.send('twofa.setup', {});
            setSetupData(res.setup);
        } catch {
            setError('Erreur lors de la génération du QR code');
        }
    };

    const verifyAndEnable = async () => {
        if (!verifyCode.trim()) return;
        setVerifying(true);
        setError(null);
        try {
            await ws.send('twofa.enable', { code: verifyCode.trim() });
            setSetupData(null);
            setVerifyCode('');
            await fetchStatus();
        } catch {
            setError('Code invalide. Vérifiez et réessayez.');
        } finally {
            setVerifying(false);
        }
    };

    const disable2FA = async () => {
        if (!disableCode.trim()) return;
        setError(null);
        try {
            await ws.send('twofa.disable', { code: disableCode.trim() });
            setShowDisableConfirm(false);
            setDisableCode('');
            await fetchStatus();
        } catch {
            setError('Code invalide');
        }
    };

    const regenerateBackupCodes = async () => {
        setError(null);
        try {
            const res = await ws.send('twofa.regenBackup', { code: '' });
            setBackupCodes(res.backupCodes);
            setShowBackupCodes(true);
            await fetchStatus();
        } catch {
            setError('Erreur lors de la régénération des codes');
        }
    };

    return (
        <div className={styles.container}>
            <h2 className={styles.title}>Authentification à deux facteurs</h2>
            <p className={styles.subtitle}>Protégez votre compte avec une couche de sécurité supplémentaire</p>

            {loading ? (
                <div className={styles.loader}>Chargement...</div>
            ) : (
                <div className={styles.content}>
                    <div className={styles.statusCard}>
                        <div className={`${styles.statusIcon} ${status?.enabled ? styles.enabled : ''}`}>
                            <span className='icon icon-shield' />
                        </div>
                        <div className={styles.statusInfo}>
                            <h3>{status?.enabled ? '2FA Activé' : '2FA Désactivé'}</h3>
                            <p>
                                {status?.enabled
                                    ? `${status.backupCodesRemaining} codes de secours restants`
                                    : 'Activez la 2FA pour sécuriser votre compte'}
                            </p>
                        </div>
                        {!status?.enabled ? (
                            <Button onClick={startSetup}>Activer</Button>
                        ) : (
                            <Button variant='danger' onClick={() => setShowDisableConfirm(true)}>
                                Désactiver
                            </Button>
                        )}
                    </div>

                    {status?.enabled && (
                        <div className={styles.backupSection}>
                            <h3>Codes de secours</h3>
                            <p>
                                Utilisez ces codes si vous perdez l&apos;accès à votre application
                                d&apos;authentification.
                            </p>
                            <Button variant='secondary' onClick={regenerateBackupCodes}>
                                Régénérer les codes de secours
                            </Button>
                        </div>
                    )}

                    {error && <div className={styles.error}>{error}</div>}

                    <AnimatePresence>
                        {setupData && (
                            <motion.div
                                className={styles.setupCard}
                                initial={{ opacity: 0, y: 20 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -20 }}
                            >
                                <h3>Configuration</h3>
                                <div className={styles.steps}>
                                    <div className={styles.step}>
                                        <span className={styles.stepNumber}>1</span>
                                        <div className={styles.stepContent}>
                                            <h4>Scannez le QR code</h4>
                                            <p>
                                                Utilisez une application comme Google Authenticator, Authy ou 1Password.
                                            </p>
                                            <div className={styles.qrContainer}>
                                                <img
                                                    src={`https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(setupData.otpauthUrl)}`}
                                                    alt='QR Code 2FA'
                                                    className={styles.qrCode}
                                                />
                                            </div>
                                            <div className={styles.manualEntry}>
                                                <span>Clé manuelle :</span>
                                                <code>{setupData.secret}</code>
                                            </div>
                                        </div>
                                    </div>

                                    <div className={styles.step}>
                                        <span className={styles.stepNumber}>2</span>
                                        <div className={styles.stepContent}>
                                            <h4>Entrez le code de vérification</h4>
                                            <p>Saisissez le code à 6 chiffres affiché dans votre application.</p>
                                            <div className={styles.verifyForm}>
                                                <input
                                                    type='text'
                                                    inputMode='numeric'
                                                    pattern='[0-9]*'
                                                    maxLength={6}
                                                    className={styles.codeInput}
                                                    value={verifyCode}
                                                    onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, ''))}
                                                    placeholder='000000'
                                                />
                                                <Button
                                                    onClick={verifyAndEnable}
                                                    disabled={verifyCode.length !== 6 || verifying}
                                                >
                                                    {verifying ? 'Vérification...' : 'Vérifier et activer'}
                                                </Button>
                                            </div>
                                        </div>
                                    </div>
                                </div>

                                <Button variant='ghost' onClick={() => setSetupData(null)}>
                                    Annuler
                                </Button>
                            </motion.div>
                        )}
                    </AnimatePresence>

                    <Dialog
                        open={showBackupCodes && backupCodes.length > 0}
                        onClose={() => setShowBackupCodes(false)}
                        title='Codes de secours'
                        description='⚠️ Sauvegardez ces codes dans un endroit sûr. Ils ne seront plus affichés après fermeture.'
                        footer={
                            <>
                                <Button
                                    variant='secondary'
                                    onClick={() => void navigator.clipboard.writeText(backupCodes.join('\n'))}
                                >
                                    Copier tous les codes
                                </Button>
                                <Button onClick={() => setShowBackupCodes(false)}>
                                    J&apos;ai sauvegardé mes codes
                                </Button>
                            </>
                        }
                    >
                        <div className={styles.codesGrid}>
                            {backupCodes.map((code, i) => (
                                <code key={i} className={styles.backupCode}>
                                    {code}
                                </code>
                            ))}
                        </div>
                    </Dialog>

                    <Dialog
                        open={showDisableConfirm}
                        onClose={() => setShowDisableConfirm(false)}
                        title='Désactiver la 2FA'
                        description='⚠️ Votre compte sera moins sécurisé. Entrez un code de votre application pour confirmer.'
                        footer={
                            <>
                                <Button variant='ghost' onClick={() => setShowDisableConfirm(false)}>
                                    Annuler
                                </Button>
                                <Button variant='danger' onClick={disable2FA} disabled={disableCode.length !== 6}>
                                    Confirmer la désactivation
                                </Button>
                            </>
                        }
                    >
                        <input
                            type='text'
                            inputMode='numeric'
                            pattern='[0-9]*'
                            maxLength={6}
                            className={styles.codeInput}
                            value={disableCode}
                            onChange={(e) => setDisableCode(e.target.value.replace(/\D/g, ''))}
                            placeholder='000000'
                        />
                    </Dialog>
                </div>
            )}
        </div>
    );
}
