import { useCallback, useEffect, useRef, useState } from 'react';
import { ws } from '@/api/ws';
import { Dialog } from '@/Components/Dialog';
import { openInfo } from '@/Components/InfoPopup';
import Button from '@/Components/Button';
import { useAuth } from '@/auth/AuthProvider';
import { refreshSecrecyStatus } from '@/stores/secrecy';
import type { SecrecyStatus, TwoFactorStatus } from 'deveye-types';
import type { FeatureProps } from '../types';
import { SecurityDialog } from './SecurityDialog';
import styles from './Security.module.css';

/** Explainers shown by the "i" buttons, via the shared root-level info popup. */
function showTwoFactorInfo() {
    void openInfo({
        title: 'Authentification à deux facteurs (TOTP)',
        body: (
            <>
                <p>
                    La 2FA utilise le protocole <strong>TOTP</strong> (RFC 6238). Un secret de 20 octets est généré côté
                    serveur et partagé une seule fois via QR code.
                </p>
                <p>
                    À chaque connexion, votre application calcule un code à 6 chiffres via{' '}
                    <code>HMAC-SHA1(secret, floor(time/30))</code>. Le serveur recalcule le même code et les compare —
                    le secret ne transite jamais après l&apos;enrôlement.
                </p>
                <p>
                    Les <strong>codes de secours</strong> sont des tokens aléatoires à usage unique, stockés en base
                    sous forme de hash SHA-256. Chaque utilisation marque le code comme consommé de façon définitive.
                </p>
            </>
        )
    });
}

function showEncryptionInfo() {
    void openInfo({
        title: 'Chiffrement par mot de passe (envelope encryption)',
        body: (
            <>
                <p>
                    Chaque utilisateur possède une <strong>DEK</strong> (Data Encryption Key) de 256 bits générée
                    aléatoirement. Les données sont chiffrées avec cette DEK via <strong>AES-256-GCM</strong>{' '}
                    (authentifié, avec IV aléatoire par bloc).
                </p>
                <p>
                    Sans ce mode activé, la DEK est elle-même chiffrée par une clé serveur (<strong>KEK</strong>)
                    stockée dans les variables d&apos;environnement — le serveur peut déchiffrer sans action de votre
                    part.
                </p>
                <p>
                    Avec ce mode activé, la DEK est chiffrée par une clé dérivée de <strong>votre mot de passe</strong>{' '}
                    via Argon2id (résistant aux GPUs). Le serveur ne stocke jamais votre mot de passe ni la DEK en clair
                    — même un accès à la base de données ne suffit pas à lire vos données.
                </p>
                <p>
                    Le <strong>code de récupération</strong> chiffre une seconde copie de la DEK via une clé Argon2id
                    distincte. Si vous oubliez votre mot de passe, ce code déverrouille la DEK et permet de redéfinir un
                    mot de passe — sans lui, les données chiffrées sont définitivement perdues.
                </p>
            </>
        )
    });
}

function showReauthInfo() {
    void openInfo({
        title: 'Délai de validation du mot de passe',
        body: (
            <>
                <p>
                    Quand le <strong>chiffrement par mot de passe</strong> est actif, votre mot de passe déverrouille la
                    clé en mémoire pour la session. Plutôt que de le redemander à chaque action, il reste valide pendant
                    une <strong>fenêtre glissante</strong> qui se réinitialise à chaque utilisation.
                </p>
                <p>
                    Ce délai définit la durée de cette fenêtre. La valeur par défaut est de <strong>1 minute</strong>.
                    Une valeur plus courte est plus sûre mais plus contraignante.
                </p>
                <p>
                    La valeur <code>0</code> offre la <strong>sécurité maximale</strong> : votre mot de passe est
                    redemandé à chaque action chiffrée, sans jamais être mis en cache.
                </p>
                <p>
                    Un délai de <strong>5 minutes ou moins</strong> est considéré comme strict et compte dans votre
                    score de sécurité.
                </p>
            </>
        )
    });
}

interface SetupData {
    secret: string;
    otpauthUrl: string;
    backupCodes: string[];
}

export default function Security({ user: _user, workspace: _ws }: FeatureProps) {
    const { updateUser } = useAuth();
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
    const [showRegenConfirm, setShowRegenConfirm] = useState(false);
    const [secrecy, setSecrecy] = useState<SecrecyStatus | null>(null);
    const [securityOpen, setSecurityOpen] = useState(false);
    // Re-auth window editor, expressed in minutes (0 = always re-prompt). Kept as
    // a string so the field can be cleared mid-edit without snapping to 0.
    const [reAuthInput, setReAuthInput] = useState('');
    // Autosave status for the re-auth window, surfaced as a small transient icon
    // next to the input rather than a button.
    const [reAuthSaveState, setReAuthSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
    const reAuthDebounce = useRef<number | undefined>(undefined);
    const reAuthSavedTimer = useRef<number | undefined>(undefined);

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
            // Seed the editor in minutes. `null` means the server default (60s = 1 min).
            const seconds = res.status.reAuthInterval ?? 60;
            setReAuthInput(String(Math.round(seconds / 60)));
        } catch {
            // ignore
        }
    }, []);

    useEffect(() => {
        void fetchStatus();
        void fetchSecrecy();
    }, [fetchStatus, fetchSecrecy]);

    // Keep the global user.security in sync so the profile's "Sécurité x / 3"
    // counter updates live, without a full page reload. Only patches once both
    // statuses are known to avoid flicker from partial state. The re-auth window
    // counts when strict: short enough (≤ 5 min), 0 being the strongest setting.
    useEffect(() => {
        if (status === null || secrecy === null) return;
        const reAuth = secrecy.reAuthInterval ?? 60;
        const reAuthValidation = reAuth <= 300;
        updateUser({
            security: {
                twoFactor: status.enabled,
                passwordEncryption: secrecy.enabled,
                reAuthValidation
            }
        });
    }, [status, secrecy, updateUser]);

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
            // Surface the backup codes minted during setup, shown only once.
            const codes = setupData?.backupCodes ?? [];
            closeSetup();
            await fetchStatus();
            if (codes.length > 0) {
                setBackupCodes(codes);
                setShowBackupCodes(true);
            }
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
            const res = await ws.send('twofa.regenBackup', {});
            setShowRegenConfirm(false);
            setBackupCodes(res.backupCodes);
            setShowBackupCodes(true);
            await fetchStatus();
        } catch {
            setShowRegenConfirm(false);
            setError('Erreur lors de la régénération des codes');
        }
    };

    // Current persisted window in minutes (null = server default of 1 min).
    const currentReAuthMinutes = Math.round((secrecy?.reAuthInterval ?? 60) / 60);
    // Whether the window is strict enough to count as a protection (≤ 5 min,
    // including 0 = "always re-prompt", the strongest setting). Same threshold as
    // the profile security counter.
    const reAuthStrict = currentReAuthMinutes <= 5;
    const reAuthTitle =
        currentReAuthMinutes === 0
            ? 'Validation du mot de passe : à chaque action'
            : `Validation du mot de passe : toutes les ${currentReAuthMinutes} min`;
    const reAuthDescription =
        currentReAuthMinutes === 0
            ? 'Sécurité maximale : votre mot de passe est redemandé à chaque action chiffrée.'
            : reAuthStrict
              ? `Bon niveau : votre mot de passe reste valide ${currentReAuthMinutes} min avant d’être redemandé.`
              : `Confort privilégié : votre mot de passe reste valide ${currentReAuthMinutes} min avant d’être redemandé. Réduisez à 5 min ou moins pour renforcer la sécurité.`;
    const parsedReAuth = Number(reAuthInput);
    const reAuthValid =
        reAuthInput.trim() !== '' && Number.isInteger(parsedReAuth) && parsedReAuth >= 0 && parsedReAuth <= 1440;
    const reAuthDirty = reAuthValid && parsedReAuth !== currentReAuthMinutes;

    const saveReAuth = useCallback(async () => {
        if (!reAuthValid) return;
        setReAuthSaveState('saving');
        try {
            const res = await ws.send('secrecy.setReauth', { seconds: parsedReAuth * 60 });
            setSecrecy(res.status);
            setReAuthSaveState('saved');
            window.clearTimeout(reAuthSavedTimer.current);
            reAuthSavedTimer.current = window.setTimeout(() => setReAuthSaveState('idle'), 2000);
        } catch {
            setReAuthSaveState('error');
        }
    }, [reAuthValid, parsedReAuth]);

    // Debounced autosave: wait 500 ms after the last edit before persisting. Any
    // change resets the timer, so we only save once the user pauses. Only fires
    // when the value is valid and actually differs from what's stored.
    useEffect(() => {
        if (!reAuthDirty) return;
        window.clearTimeout(reAuthDebounce.current);
        reAuthDebounce.current = window.setTimeout(() => void saveReAuth(), 500);
        return () => window.clearTimeout(reAuthDebounce.current);
    }, [reAuthDirty, reAuthInput, saveReAuth]);

    // Clean up any pending timers on unmount.
    useEffect(
        () => () => {
            window.clearTimeout(reAuthDebounce.current);
            window.clearTimeout(reAuthSavedTimer.current);
        },
        []
    );

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
                        <button className={styles.infoBtn} onClick={showTwoFactorInfo} title='Comment ça fonctionne ?'>
                            <span className='icon icon-info' />
                        </button>
                        {!status?.enabled ? (
                            <Button onClick={startSetup}>Activer</Button>
                        ) : (
                            <>
                                <button
                                    className={styles.resetBtn}
                                    onClick={() => setShowRegenConfirm(true)}
                                    title='Régénérer les codes de secours'
                                >
                                    <span className='icon icon-refresh' />
                                </button>
                                <Button variant='danger' onClick={() => setShowDisableConfirm(true)}>
                                    Désactiver
                                </Button>
                            </>
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
                        <button className={styles.infoBtn} onClick={showEncryptionInfo} title='Comment ça fonctionne ?'>
                            <span className='icon icon-info' />
                        </button>
                        <Button variant={secrecy?.enabled ? 'danger' : 'primary'} onClick={() => setSecurityOpen(true)}>
                            {secrecy?.enabled ? 'Désactiver' : 'Activer'}
                        </Button>
                    </div>

                    <div className={styles.statusCard}>
                        <div className={`${styles.statusIcon} ${reAuthStrict ? styles.enabled : ''}`}>
                            <span className='icon icon-shield' />
                        </div>
                        <div className={styles.statusInfo}>
                            <h3>{reAuthTitle}</h3>
                            <p>{reAuthDescription}</p>
                        </div>
                        <button className={styles.infoBtn} onClick={showReauthInfo} title='Comment ça fonctionne ?'>
                            <span className='icon icon-info' />
                        </button>
                        <div className={styles.reAuthEditor}>
                            <input
                                type='number'
                                inputMode='numeric'
                                min={0}
                                max={1440}
                                step={1}
                                className={styles.reAuthInput}
                                value={reAuthInput}
                                onChange={(e) => setReAuthInput(e.target.value.replace(/\D/g, ''))}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter' && reAuthDirty) void saveReAuth();
                                }}
                                aria-label='Délai de validation en minutes'
                            />
                            <span className={styles.reAuthUnit}>min</span>
                            <span className={styles.reAuthStatus} aria-live='polite'>
                                {reAuthSaveState === 'saving' && (
                                    <span
                                        key='saving'
                                        className={`icon icon-spinner ${styles.reAuthSpin}`}
                                        title='Enregistrement…'
                                    />
                                )}
                                {reAuthSaveState === 'saved' && (
                                    <span
                                        key='saved'
                                        className={`icon icon-check-circle ${styles.reAuthOk}`}
                                        title='Enregistré'
                                    />
                                )}
                                {reAuthSaveState === 'error' && (
                                    <span
                                        key='error'
                                        className={`icon icon-x-circle ${styles.reAuthErr}`}
                                        title="Échec de l'enregistrement"
                                    />
                                )}
                            </span>
                        </div>
                    </div>

                    {error && <div className={styles.error}>{error}</div>}

                    <Dialog
                        open={setupOpen}
                        onClose={closeSetup}
                        title='Configurer la 2FA'
                        width={520}
                        onSubmit={() => {
                            if (setupData && verifyCode.length === 6) void verifyAndEnable();
                        }}
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
                        onSubmit={() => setShowBackupCodes(false)}
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
                        onSubmit={() => {
                            if (disableCode.length === 6) void disable2FA();
                        }}
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

                    <Dialog
                        open={showRegenConfirm}
                        onClose={() => setShowRegenConfirm(false)}
                        title='Réinitialiser les codes de secours'
                        description='⚠️ Vos anciens codes de secours seront définitivement invalidés et de nouveaux seront générés. Continuer ?'
                        onSubmit={() => void regenerateBackupCodes()}
                        footer={
                            <>
                                <Button variant='ghost' onClick={() => setShowRegenConfirm(false)}>
                                    Non
                                </Button>
                                <Button variant='danger' onClick={regenerateBackupCodes}>
                                    Oui, réinitialiser
                                </Button>
                            </>
                        }
                    />

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
