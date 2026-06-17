import { useCallback, useEffect, useState } from 'react';
import { ws } from '@/api/ws';
import { Dialog } from '@/Components/Dialog';
import Button from '@/Components/Button';
import { refreshSecrecyStatus } from '@/stores/secrecy';
import type { SecrecyStatus, TwoFactorStatus } from 'deveye-types';
import type { FeatureProps } from '../types';
import { SecurityDialog } from './SecurityDialog';
import styles from './TwoFactor.module.css';

interface SetupData {
    secret: string;
    otpauthUrl: string;
    backupCodes: string[];
}

export default function TwoFactor({ user: _user, workspace: _ws }: FeatureProps) {
    const [status, setStatus] = useState<TwoFactorStatus | null>(null);
    const [loading, setLoading] = useState(true);
    const [setupData, setSetupData] = useState<SetupData | null>(null);
    const [setupOpen, setSetupOpen] = useState(false);
    const [verifyCode, setVerifyCode] = useState('');
    const [verifying, setVerifying] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [showBackupCodes, setShowBackupCodes] = useState(false);
    const [backupCodes, setBackupCodes] = useState<string[]>([]);
    const [showDisableConfirm, setShowDisableConfirm] = useState(false);
    const [disableCode, setDisableCode] = useState('');
    const [secrecy, setSecrecy] = useState<SecrecyStatus | null>(null);
    const [securityOpen, setSecurityOpen] = useState(false);

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

    const fetchSecrecy = useCallback(async () => {
        try {
            const res = await ws.send('secrecy.status', {});
            setSecrecy(res.status);
        } catch {
            // ignore
        }
    }, []);

    useEffect(() => {
        void fetchStatus();
        void fetchSecrecy();
    }, [fetchStatus, fetchSecrecy]);

    const startSetup = async () => {
        // Open the dialog right away (with a loader) so it doesn't feel laggy
        // while the secret/QR are minted server-side.
        setError(null);
        setSetupData(null);
        setVerifyCode('');
        setSetupOpen(true);
        try {
            const res = await ws.send('twofa.setup', {});
            setSetupData(res.setup);
        } catch {
            setSetupOpen(false);
            setError('Erreur lors de la génération du QR code');
        }
    };

    const closeSetup = () => {
        setSetupOpen(false);
        setSetupData(null);
        setVerifyCode('');
    };

    const verifyAndEnable = async () => {
        if (!verifyCode.trim()) return;
        setVerifying(true);
        setError(null);
        try {
            await ws.send('twofa.enable', { code: verifyCode.trim() });
            closeSetup();
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
            <h2 className={styles.title}>Sécurité</h2>
            <p className={styles.subtitle}>
                Protégez votre compte et vos données avec des couches de sécurité supplémentaires
            </p>

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

                    <div className={styles.statusCard}>
                        <div className={`${styles.statusIcon} ${secrecy?.enabled ? styles.enabled : ''}`}>
                            <span className='icon icon-shield' />
                        </div>
                        <div className={styles.statusInfo}>
                            <h3>
                                {secrecy?.enabled
                                    ? 'Chiffrement par mot de passe activé'
                                    : 'Chiffrement par mot de passe désactivé'}
                            </h3>
                            <p>
                                {secrecy?.enabled
                                    ? 'Vos données chiffrées sont verrouillées par votre mot de passe.'
                                    : 'Verrouillez vos données chiffrées avec votre mot de passe.'}
                            </p>
                        </div>
                        <Button variant={secrecy?.enabled ? 'danger' : 'primary'} onClick={() => setSecurityOpen(true)}>
                            {secrecy?.enabled ? 'Désactiver' : 'Activer'}
                        </Button>
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

                    <Dialog
                        open={setupOpen}
                        onClose={closeSetup}
                        title='Configurer la 2FA'
                        width={520}
                        footer={
                            <>
                                <Button variant='secondary' onClick={closeSetup} disabled={verifying}>
                                    Annuler
                                </Button>
                                <Button
                                    onClick={verifyAndEnable}
                                    disabled={!setupData || verifyCode.length !== 6 || verifying}
                                >
                                    {verifying ? 'Vérification...' : 'Vérifier et activer'}
                                </Button>
                            </>
                        }
                    >
                        {!setupData ? (
                            <div className={styles.loader}>Génération du QR code…</div>
                        ) : (
                            <div className={styles.steps}>
                                <div className={styles.step}>
                                    <span className={styles.stepNumber}>1</span>
                                    <div className={styles.stepContent}>
                                        <h4>Scannez le QR code</h4>
                                        <p>Utilisez une application comme Google Authenticator, Authy ou 1Password.</p>
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
                                        <input
                                            type='text'
                                            inputMode='numeric'
                                            pattern='[0-9]*'
                                            maxLength={6}
                                            className={styles.codeInput}
                                            value={verifyCode}
                                            onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, ''))}
                                            placeholder='000000'
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter' && verifyCode.length === 6)
                                                    void verifyAndEnable();
                                            }}
                                        />
                                    </div>
                                </div>
                            </div>
                        )}
                    </Dialog>

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

                    <SecurityDialog
                        open={securityOpen}
                        enabled={secrecy?.enabled ?? false}
                        onClose={() => setSecurityOpen(false)}
                        onChanged={() => {
                            void fetchSecrecy();
                            void refreshSecrecyStatus();
                        }}
                    />
                </div>
            )}
        </div>
    );
}
