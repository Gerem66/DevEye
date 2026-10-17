import { useCallback, useEffect, useMemo, useState } from 'react';
import { ws, WsError } from '@/api/ws';
import { AuthenticatorCodeField, authenticatorCodeReady, CodeInput } from '@/Components/CodeInput';
import { Dialog } from '@/Components/Dialog';
import TextInput from '@/Components/TextInput';
import { openInfo } from '@/Components/InfoPopup';
import Button from '@/Components/Button';
import CopyButton from '@/Components/CopyButton';
import { StatusBadge } from '@/Components/StatusBadge';
import StickyHeader from '@/Components/StickyHeader';
import Switch from '@/Components/Switch';
import { useAuth } from '@/auth/AuthProvider';
import { copyText } from '@/copyText';
import { refreshSecrecyStatus } from '@/stores/secrecy';
import {
    STEP_UP_MINUTES_MAX,
    STEP_UP_MINUTES_MIN,
    STEP_UP_STRICT_MINUTES,
    TRUSTED_BROWSERS_MAX,
    type LoginChecksStatus,
    type SecrecyStatus,
    type StepUpStatus,
    type TwoFactorStatus,
    type UserSecurity
} from '@deveye/types';
import type { FeatureProps } from '../types';
import { EmailCheckRow, SmsCheckRow, TrustedBrowsersRow } from './LoginChecks';
import { MinutesEditor } from './MinutesEditor';
import { Reveal, Row, Section } from './Row';
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
                    <code>HMAC-SHA1(secret, floor(time/30))</code>. Le serveur recalcule le même code et les compare :
                    le secret ne transite jamais après l&apos;enrôlement.
                </p>
                <p>
                    Les <strong>codes de secours</strong> sont des tokens aléatoires à usage unique. La base n&apos;en
                    garde qu&apos;un condensé calculé sous une clé du serveur : une copie de la base seule ne permet pas
                    de les retrouver. Chaque utilisation marque le code comme consommé de façon définitive.
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
                    stockée dans les variables d&apos;environnement : le serveur peut déchiffrer sans action de votre
                    part.
                </p>
                <p>
                    Avec ce mode activé, la DEK est chiffrée par une clé dérivée de <strong>votre mot de passe</strong>{' '}
                    via Argon2id (résistant aux GPUs). Le serveur ne stocke jamais votre mot de passe ni la DEK en clair
                    : même un accès à la base de données ne suffit pas à lire vos données.
                </p>
                <p>
                    Ce mode protège l&apos;étage gardé (notes privées, coffre, projets confidentiels). Ce qu&apos;une
                    tâche de fond doit lire sans vous (Uptime, intégrations, CloudSync) reste chiffré au repos mais
                    lisible par le serveur.
                </p>
                <p>
                    Le <strong>code de récupération</strong> chiffre une seconde copie de la DEK via une clé Argon2id
                    distincte. Si vous oubliez votre mot de passe, ce code déverrouille la DEK et permet de redéfinir un
                    mot de passe : sans lui, les données chiffrées sont définitivement perdues.
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

function showStepUpInfo() {
    void openInfo({
        title: 'Confirmation pour piloter vos machines',
        body: (
            <>
                <p>
                    Un agent DevEye peut tout faire sur sa machine : ouvrir un terminal, lire et écrire ses fichiers,
                    l&apos;éteindre, mettre à jour ses paquets. Quelqu&apos;un qui aurait volé votre mot de passe, ou le
                    cookie de votre navigateur, ne doit pas pouvoir le faire à votre place.
                </p>
                <p>
                    Avant de piloter une machine, DevEye demande donc le code de votre application
                    d&apos;authentification. Il reste valable dans ce navigateur tant que vous continuez à piloter, et
                    se redemande après le délai choisi ici sans aucune action sur une machine.
                </p>
                <p>
                    Regarder une machine (mesures, état, processus) ne demande rien : seul ce qui la fait agir ou en lit
                    le contenu est confirmé.
                </p>
            </>
        )
    });
}

interface SetupData {
    secret: string;
    otpauthUrl: string;
    qrDataUrl: string;
    backupCodes: string[];
}

export default function Security({ user: _user, workspace: _ws }: FeatureProps) {
    const { updateUser } = useAuth();
    const [status, setStatus] = useState<TwoFactorStatus | null>(null);
    const [setupData, setSetupData] = useState<SetupData | null>(null);
    const [setupOpen, setSetupOpen] = useState(false);
    // Le mot de passe du compte, demandé avant de produire le secret : une
    // session volée ne pose pas sa propre application.
    const [setupPassword, setSetupPassword] = useState('');
    const [setupPasswordError, setSetupPasswordError] = useState<string | null>(null);
    const [setupLoading, setSetupLoading] = useState(false);
    const [verifyCode, setVerifyCode] = useState('');
    const [verifying, setVerifying] = useState(false);
    // L'échec de la vérification du premier code, affiché dans le dialogue où il a été saisi.
    const [verifyError, setVerifyError] = useState<string | null>(null);
    const [showBackupCodes, setShowBackupCodes] = useState(false);
    const [backupCodes, setBackupCodes] = useState<string[]>([]);
    const [showDisableConfirm, setShowDisableConfirm] = useState(false);
    const [disableCode, setDisableCode] = useState('');
    const [disableRecovery, setDisableRecovery] = useState(false);
    // L'erreur du dialogue de désactivation (code faux) s'affiche là où le code
    // a été saisi.
    const [disableError, setDisableError] = useState<string | null>(null);
    const [showRegenConfirm, setShowRegenConfirm] = useState(false);
    const [regenCode, setRegenCode] = useState('');
    const [regenRecovery, setRegenRecovery] = useState(false);
    const [regenError, setRegenError] = useState<string | null>(null);
    const [secrecy, setSecrecy] = useState<SecrecyStatus | null>(null);
    const [securityOpen, setSecurityOpen] = useState(false);
    const [stepUp, setStepUp] = useState<StepUpStatus | null>(null);
    const [checks, setChecks] = useState<LoginChecksStatus | null>(null);

    const fetchStatus = useCallback(async () => {
        try {
            const res = await ws.send('twofa.status', {});
            setStatus(res.status);
        } catch {
            // ignore
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

    const fetchStepUp = useCallback(async () => {
        try {
            const res = await ws.send('stepup.status', {});
            setStepUp(res.status);
        } catch {
            // ignore
        }
    }, []);

    const fetchChecks = useCallback(async () => {
        try {
            const res = await ws.send('loginChecks.status', {});
            setChecks(res.status);
        } catch {
            // ignore
        }
    }, []);

    useEffect(() => {
        void fetchStatus();
        void fetchSecrecy();
        void fetchStepUp();
        void fetchChecks();
    }, [fetchStatus, fetchSecrecy, fetchStepUp, fetchChecks]);

    // Le niveau de sécurité, du même compte que le serveur (`loadUserBundle`) :
    // un délai ne compte qu'avec la protection qu'il précise. `null` tant qu'un
    // état manque, pour ne pas afficher un compte qui bouge.
    const security = useMemo<UserSecurity | null>(() => {
        if (status === null || secrecy === null || checks === null || stepUp === null) return null;
        const loginAvailable = checks.email.available || checks.sms.available;
        const loginConfirmation = loginAvailable
            ? (checks.email.available && checks.email.enabled) || (checks.sms.available && checks.sms.enabled)
            : null;
        return {
            loginConfirmation,
            trustedBrowsers:
                loginConfirmation === null ? null : loginConfirmation && checks.browsers.length <= TRUSTED_BROWSERS_MAX,
            twoFactor: status.enabled,
            stepUpValidation: status.enabled && stepUp.minutes <= STEP_UP_STRICT_MINUTES,
            passwordEncryption: secrecy.enabled,
            reAuthValidation: secrecy.enabled && (secrecy.reAuthInterval ?? 60) <= 300
        };
    }, [status, secrecy, checks, stepUp]);

    // Le compteur « Sécurité x / y » du Profil suit la page en direct.
    useEffect(() => {
        if (security) updateUser({ security });
    }, [security, updateUser]);

    const startSetup = () => {
        setVerifyError(null);
        setSetupData(null);
        setVerifyCode('');
        setSetupPassword('');
        setSetupPasswordError(null);
        setSetupOpen(true);
    };

    /** Le mot de passe vérifié, le serveur produit le secret et son QR code. */
    const requestSetup = async () => {
        if (!setupPassword || setupLoading) return;
        setSetupLoading(true);
        setSetupPasswordError(null);
        try {
            const res = await ws.send('twofa.setup', { password: setupPassword });
            setSetupPassword('');
            setSetupData(res.setup);
        } catch (e) {
            setSetupPassword('');
            setSetupPasswordError(
                e instanceof WsError && e.code === 'auth_invalid'
                    ? 'Mot de passe incorrect'
                    : e instanceof Error
                      ? e.message
                      : 'Erreur lors de la génération du QR code'
            );
        } finally {
            setSetupLoading(false);
        }
    };

    const closeSetup = () => {
        setSetupOpen(false);
        setSetupData(null);
        setVerifyCode('');
        setSetupPassword('');
        setSetupPasswordError(null);
    };

    const verifyAndEnable = async () => {
        if (!verifyCode.trim()) return;
        setVerifying(true);
        setVerifyError(null);
        try {
            await ws.send('twofa.enable', { code: verifyCode.trim() });
            // Surface the backup codes minted during setup, shown only once.
            const codes = setupData?.backupCodes ?? [];
            closeSetup();
            await fetchStatus();
            void fetchStepUp();
            if (codes.length > 0) {
                setBackupCodes(codes);
                setShowBackupCodes(true);
            }
        } catch {
            setVerifyError('Code invalide. Vérifiez et réessayez.');
        } finally {
            setVerifying(false);
        }
    };

    const disable2FA = async () => {
        if (!disableCode.trim()) return;
        setDisableError(null);
        try {
            await ws.send('twofa.disable', { code: disableCode.trim() });
            setShowDisableConfirm(false);
            setDisableCode('');
            await fetchStatus();
            void fetchStepUp();
        } catch {
            setDisableCode('');
            setDisableError('Code invalide');
        }
    };

    /** Open the disable dialog from a clean slate (no stale code or error). */
    const openDisableConfirm = () => {
        setDisableCode('');
        setDisableRecovery(false);
        setDisableError(null);
        setShowDisableConfirm(true);
    };

    const closeDisableConfirm = () => {
        setShowDisableConfirm(false);
        setDisableError(null);
    };

    const openRegenConfirm = () => {
        setRegenCode('');
        setRegenRecovery(false);
        setRegenError(null);
        setShowRegenConfirm(true);
    };

    const regenerateBackupCodes = async (code: string = regenCode) => {
        if (!authenticatorCodeReady(code, regenRecovery)) return;
        setRegenError(null);
        try {
            const res = await ws.send('twofa.regenBackup', { code });
            setShowRegenConfirm(false);
            setBackupCodes(res.backupCodes);
            setShowBackupCodes(true);
            await fetchStatus();
        } catch (e) {
            setRegenCode('');
            setRegenError(
                e instanceof WsError && e.code === 'auth_invalid'
                    ? 'Code incorrect'
                    : 'Erreur lors de la régénération des codes'
            );
        }
    };

    const saveStepUpMinutes = useCallback(async (minutes: number) => {
        const res = await ws.send('stepup.setInterval', { minutes });
        setStepUp(res.status);
    }, []);

    const encryptionEnabled = secrecy?.enabled ?? false;
    // La fenêtre enregistrée, en minutes (null : la minute du serveur par défaut).
    const currentReAuthMinutes = Math.round((secrecy?.reAuthInterval ?? 60) / 60);
    const reAuthHint =
        currentReAuthMinutes === 0
            ? 'Sécurité maximale : votre mot de passe est redemandé à chaque action.'
            : currentReAuthMinutes <= 5
              ? 'Après ce délai sans action, votre mot de passe est redemandé.'
              : 'Après ce délai sans action, votre mot de passe est redemandé. Cinq minutes ou moins renforcent la sécurité.';

    const saveReAuth = useCallback(async (minutes: number) => {
        const res = await ws.send('secrecy.setReauth', { seconds: minutes * 60 });
        setSecrecy(res.status);
        // Keep the global unlock store in sync: switching to/from 0 changes the
        // "validate on every action" mode, which governs whether actions re-prompt.
        void refreshSecrecyStatus();
    }, []);

    const twoFactorOn = status?.enabled === true;
    const backupCodesRemaining = status?.backupCodesRemaining ?? 0;
    const backupCodesHint =
        backupCodesRemaining === 0
            ? 'Plus aucun code : régénérez-en avant d’en avoir besoin.'
            : backupCodesRemaining === 1
              ? 'Un seul code restant, pour entrer sans votre téléphone.'
              : `${backupCodesRemaining} codes restants, pour entrer sans votre téléphone.`;
    const stepUpMinutes = stepUp?.minutes ?? 15;
    const stepUpReady = stepUp?.twoFactor === true;
    const stepUpHint =
        stepUpMinutes <= STEP_UP_STRICT_MINUTES
            ? 'Le code est demandé avant d’agir sur une machine, puis de nouveau après ce délai sans y toucher.'
            : `Le code est demandé avant d’agir sur une machine, puis de nouveau après ce délai sans y toucher. ${STEP_UP_STRICT_MINUTES} minutes ou moins renforcent la sécurité.`;

    // Chaque groupe compte deux protections : la sienne et le réglage qui la
    // précise. Sans mail ni SMS, le groupe Connexion n'existe pas.
    const count = (...flags: (boolean | null)[]) => flags.filter(Boolean).length;
    const loginCount = security ? count(security.loginConfirmation, security.trustedBrowsers) : 0;
    const twoFactorCount = security ? count(security.twoFactor, security.stepUpValidation) : 0;
    const encryptionCount = security ? count(security.passwordEncryption, security.reAuthValidation) : 0;
    const activeCount = loginCount + twoFactorCount + encryptionCount;
    const totalCount = security?.loginConfirmation === null ? 4 : 6;
    const allActive = activeCount === totalCount;

    return (
        <div className={styles.container}>
            <StickyHeader>
                <div className={styles.header}>
                    <div>
                        <h2 className={styles.title}>Sécurité</h2>
                        <p className={styles.subtitle}>Les protections de votre compte et de vos données.</p>
                    </div>
                    {security && (
                        <StatusBadge tone={allActive ? 'success' : 'warning'}>
                            {activeCount} protection{activeCount > 1 ? 's' : ''} sur {totalCount}
                        </StatusBadge>
                    )}
                </div>
            </StickyHeader>

            {security === null || checks === null ? (
                <div className={styles.loader}>Chargement...</div>
            ) : (
                <div className={styles.content}>
                    {security.loginConfirmation !== null && (
                        <Section
                            title='Connexion'
                            description='Ce qui est vérifié, en plus du mot de passe, quand vous vous connectez depuis un navigateur que DevEye ne connaît pas.'
                            active={loginCount}
                            total={2}
                        >
                            {checks.email.available && <EmailCheckRow checks={checks} onChange={setChecks} />}
                            {checks.sms.available && <SmsCheckRow checks={checks} onChange={setChecks} />}
                            <Reveal open={checks.email.enabled || checks.sms.enabled}>
                                <TrustedBrowsersRow checks={checks} onChange={setChecks} />
                            </Reveal>
                        </Section>
                    )}

                    <Section
                        title='Double authentification'
                        description='Un code généré par une application sur votre téléphone, à chaque connexion et avant de piloter une machine.'
                        active={twoFactorCount}
                        total={2}
                    >
                        <Row
                            label='Application d’authentification'
                            icon='shield'
                            tone={twoFactorOn ? 'accent' : undefined}
                            onInfo={showTwoFactorInfo}
                            hint={
                                twoFactorOn
                                    ? 'Après le mot de passe, le code de votre application confirme chaque connexion.'
                                    : 'Un code de votre téléphone à chaque connexion, en plus du mot de passe.'
                            }
                        >
                            <Switch
                                checked={twoFactorOn}
                                aria-label='Application d’authentification'
                                onChange={(on) => {
                                    if (on) startSetup();
                                    else openDisableConfirm();
                                }}
                            />
                        </Row>
                        <Reveal open={twoFactorOn}>
                            <Row sub icon='key' label='Codes de secours' hint={backupCodesHint}>
                                <Button variant='secondary' onClick={openRegenConfirm}>
                                    Régénérer
                                </Button>
                            </Row>
                        </Reveal>
                        <Reveal open={stepUpReady}>
                            <Row
                                sub
                                icon='refresh'
                                tone={stepUpMinutes <= STEP_UP_STRICT_MINUTES ? 'accent' : 'warning'}
                                label='Pilotage des machines'
                                onInfo={showStepUpInfo}
                                hint={stepUpHint}
                            >
                                <MinutesEditor
                                    value={stepUpMinutes}
                                    min={STEP_UP_MINUTES_MIN}
                                    max={STEP_UP_MINUTES_MAX}
                                    onSave={saveStepUpMinutes}
                                    aria-label='Délai avant de redemander le code, en minutes'
                                />
                            </Row>
                        </Reveal>
                    </Section>

                    <Section
                        title='Chiffrement'
                        description='Vos données chiffrées, verrouillées par votre mot de passe plutôt que par la clé du serveur.'
                        active={encryptionCount}
                        total={2}
                    >
                        <Row
                            label='Chiffrement par mot de passe'
                            icon='lock'
                            tone={encryptionEnabled ? 'accent' : undefined}
                            onInfo={showEncryptionInfo}
                            hint={
                                encryptionEnabled
                                    ? 'Vos données chiffrées ne se lisent qu’avec votre mot de passe.'
                                    : 'Verrouillez vos données chiffrées avec votre mot de passe : sans lui, le serveur lui-même ne peut pas les lire.'
                            }
                        >
                            <Switch
                                checked={encryptionEnabled}
                                aria-label='Chiffrement par mot de passe'
                                onChange={() => setSecurityOpen(true)}
                            />
                        </Row>
                        <Reveal open={encryptionEnabled}>
                            <Row
                                sub
                                icon='refresh'
                                tone={currentReAuthMinutes <= 5 ? 'accent' : 'warning'}
                                label='Validation du mot de passe'
                                onInfo={showReauthInfo}
                                hint={reAuthHint}
                            >
                                <MinutesEditor
                                    value={currentReAuthMinutes}
                                    min={0}
                                    max={1440}
                                    onSave={saveReAuth}
                                    aria-label='Délai de validation en minutes'
                                />
                            </Row>
                        </Reveal>
                    </Section>

                    <Dialog
                        open={setupOpen}
                        onClose={closeSetup}
                        title='Activer l’application d’authentification'
                        width={640}
                        description={
                            setupData ? undefined : 'Pour commencer, saisissez le mot de passe de votre compte.'
                        }
                        onSubmit={() => {
                            if (!setupData) void requestSetup();
                            else if (verifyCode.length === 6) void verifyAndEnable();
                        }}
                        footer={
                            <>
                                <Button variant='secondary' onClick={closeSetup} disabled={verifying || setupLoading}>
                                    Annuler
                                </Button>
                                {setupData ? (
                                    <Button onClick={verifyAndEnable} disabled={verifyCode.length !== 6 || verifying}>
                                        {verifying ? 'Vérification...' : 'Vérifier et activer'}
                                    </Button>
                                ) : (
                                    <Button
                                        onClick={() => void requestSetup()}
                                        disabled={!setupPassword || setupLoading}
                                    >
                                        {setupLoading ? 'Génération du QR code…' : 'Continuer'}
                                    </Button>
                                )}
                            </>
                        }
                    >
                        {!setupData ? (
                            <TextInput
                                type='password'
                                enableShowHideButton
                                autoComplete='current-password'
                                placeholder='Mot de passe'
                                value={setupPassword}
                                error={setupPasswordError ?? undefined}
                                onChange={(e) => {
                                    setSetupPassword(e.target.value);
                                    setSetupPasswordError(null);
                                }}
                            />
                        ) : (
                            <div className={styles.steps}>
                                <div className={styles.step}>
                                    <span className={styles.stepNumber}>1</span>
                                    <div className={styles.stepContent}>
                                        <h4>Scannez le QR code</h4>
                                        <p>Utilisez une application comme Google Authenticator, Authy ou 1Password.</p>
                                        <div className={styles.qrContainer}>
                                            <img
                                                src={setupData.qrDataUrl}
                                                alt='QR Code 2FA'
                                                className={styles.qrCode}
                                            />
                                        </div>
                                    </div>
                                </div>

                                {/* Entre les deux étapes dans le document (l'ordre d'un écran
                                    étroit), sous elles et sur toute la largeur en colonnes. */}
                                <div className={styles.manualEntry}>
                                    <span>Scan impossible ? Saisissez cette clé dans l’application :</span>
                                    <div className={styles.manualKey}>
                                        <code>{setupData.secret}</code>
                                        <CopyButton value={setupData.secret} label='Copier la clé' />
                                    </div>
                                </div>

                                <div className={styles.step}>
                                    <span className={styles.stepNumber}>2</span>
                                    <div className={styles.stepContent}>
                                        <h4>Entrez le code de vérification</h4>
                                        <p>Saisissez le code à 6 chiffres affiché dans votre application.</p>
                                        <CodeInput value={verifyCode} onChange={setVerifyCode} />
                                        {verifyError && <div className={styles.formError}>{verifyError}</div>}
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
                                <Button variant='secondary' onClick={() => void copyText(backupCodes.join('\n'))}>
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
                        onClose={closeDisableConfirm}
                        title='Désactiver l’application d’authentification'
                        description='⚠️ Votre compte sera moins sécurisé, et vos machines ne pourront plus être pilotées. Entrez un code de votre application pour confirmer.'
                        onSubmit={() => {
                            if (authenticatorCodeReady(disableCode, disableRecovery)) void disable2FA();
                        }}
                        footer={
                            <>
                                <Button variant='ghost' onClick={closeDisableConfirm}>
                                    Annuler
                                </Button>
                                <Button
                                    variant='danger'
                                    onClick={disable2FA}
                                    disabled={!authenticatorCodeReady(disableCode, disableRecovery)}
                                >
                                    Confirmer la désactivation
                                </Button>
                            </>
                        }
                    >
                        <AuthenticatorCodeField
                            value={disableCode}
                            recovery={disableRecovery}
                            onRecoveryChange={setDisableRecovery}
                            error={disableError}
                            autoFocus
                            onChange={(value) => {
                                setDisableCode(value);
                                setDisableError(null);
                            }}
                        />
                    </Dialog>

                    <Dialog
                        open={showRegenConfirm}
                        onClose={() => setShowRegenConfirm(false)}
                        title='Réinitialiser les codes de secours'
                        description='⚠️ Vos anciens codes de secours seront définitivement invalidés et de nouveaux seront générés. Entrez un code de votre application pour confirmer.'
                        onSubmit={() => void regenerateBackupCodes()}
                        footer={
                            <>
                                <Button variant='ghost' onClick={() => setShowRegenConfirm(false)}>
                                    Annuler
                                </Button>
                                <Button
                                    variant='danger'
                                    onClick={() => void regenerateBackupCodes()}
                                    disabled={!authenticatorCodeReady(regenCode, regenRecovery)}
                                >
                                    Réinitialiser
                                </Button>
                            </>
                        }
                    >
                        <AuthenticatorCodeField
                            value={regenCode}
                            recovery={regenRecovery}
                            onRecoveryChange={setRegenRecovery}
                            error={regenError}
                            autoFocus
                            onChange={(value) => {
                                setRegenCode(value);
                                setRegenError(null);
                            }}
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
