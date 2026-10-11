import { useCallback, useEffect, useState } from 'react';
import { ws, WsError } from '@/api/ws';
import { AuthenticatorCodeField, authenticatorCodeReady, CodeInput } from '@/Components/CodeInput';
import { Dialog } from '@/Components/Dialog';
import TextInput from '@/Components/TextInput';
import { openInfo } from '@/Components/InfoPopup';
import Button from '@/Components/Button';
import CopyButton from '@/Components/CopyButton';
import StickyHeader from '@/Components/StickyHeader';
import Term from '@/Components/Term';
import { useAuth } from '@/auth/AuthProvider';
import { copyText } from '@/copyText';
import { refreshSecrecyStatus } from '@/stores/secrecy';
import {
    STEP_UP_MINUTES_MAX,
    STEP_UP_MINUTES_MIN,
    type SecrecyStatus,
    type StepUpStatus,
    type TwoFactorStatus
} from '@deveye/types';
import type { FeatureProps } from '../types';
import { MinutesEditor } from './MinutesEditor';
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
    const [loading, setLoading] = useState(true);
    const [setupData, setSetupData] = useState<SetupData | null>(null);
    const [setupOpen, setSetupOpen] = useState(false);
    // Le mot de passe du compte, demandé avant de produire le secret : une
    // session volée ne pose pas sa propre application.
    const [setupPassword, setSetupPassword] = useState('');
    const [setupPasswordError, setSetupPasswordError] = useState<string | null>(null);
    const [setupLoading, setSetupLoading] = useState(false);
    const [verifyCode, setVerifyCode] = useState('');
    const [verifying, setVerifying] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [showBackupCodes, setShowBackupCodes] = useState(false);
    const [backupCodes, setBackupCodes] = useState<string[]>([]);
    const [showDisableConfirm, setShowDisableConfirm] = useState(false);
    const [disableCode, setDisableCode] = useState('');
    const [disableRecovery, setDisableRecovery] = useState(false);
    // Disable-dialog error (e.g. wrong code) lives here, not in the page-level
    // `error`, so it shows inside the dialog where the code was entered.
    const [disableError, setDisableError] = useState<string | null>(null);
    const [showRegenConfirm, setShowRegenConfirm] = useState(false);
    const [regenCode, setRegenCode] = useState('');
    const [regenRecovery, setRegenRecovery] = useState(false);
    const [regenError, setRegenError] = useState<string | null>(null);
    const [secrecy, setSecrecy] = useState<SecrecyStatus | null>(null);
    const [securityOpen, setSecurityOpen] = useState(false);
    const [stepUp, setStepUp] = useState<StepUpStatus | null>(null);

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

    const fetchStepUp = useCallback(async () => {
        try {
            const res = await ws.send('stepup.status', {});
            setStepUp(res.status);
        } catch {
            // ignore
        }
    }, []);

    useEffect(() => {
        void fetchStatus();
        void fetchSecrecy();
        void fetchStepUp();
    }, [fetchStatus, fetchSecrecy, fetchStepUp]);

    // Keeps the profile's "Sécurité x / 3" counter live. Waits for both statuses
    // to avoid flicker, and counts the re-auth window only when it is strict AND
    // encryption is on (see STRICT_RE_AUTH_MINUTES below).
    useEffect(() => {
        if (status === null || secrecy === null) return;
        const reAuth = secrecy.reAuthInterval ?? 60;
        const reAuthValidation = secrecy.enabled && reAuth <= 300;
        updateUser({
            security: {
                twoFactor: status.enabled,
                passwordEncryption: secrecy.enabled,
                reAuthValidation
            }
        });
    }, [status, secrecy, updateUser]);

    const startSetup = () => {
        setError(null);
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
        setError(null);
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
            setError('Code invalide. Vérifiez et réessayez.');
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

    // The re-auth window only makes sense once password encryption is ON: it
    // governs how often that password is re-checked. Disabled otherwise.
    const encryptionEnabled = secrecy?.enabled ?? false;
    /**
     * Le geste secondaire d'une carte. Tant qu'aucune n'en a, l'emplacement
     * n'existe chez personne : l'aide vient alors coller aux commandes.
     */
    const extraColumn = status?.enabled === true;
    // Current persisted window in minutes (null = server default of 1 min).
    const currentReAuthMinutes = Math.round((secrecy?.reAuthInterval ?? 60) / 60);
    // Strict enough to count as a protection: 5 min or less, 0 ("always
    // re-prompt") being the strongest.
    const reAuthStrict = encryptionEnabled && currentReAuthMinutes <= 5;
    const reAuthTitle = !encryptionEnabled
        ? 'Validation du mot de passe'
        : currentReAuthMinutes === 0
          ? 'Validation du mot de passe : à chaque action'
          : `Validation du mot de passe : toutes les ${currentReAuthMinutes} min`;
    const reAuthDescription = !encryptionEnabled
        ? 'Dépend du chiffrement par mot de passe : activez-le pour définir ce délai.'
        : currentReAuthMinutes === 0
          ? 'Sécurité maximale : votre mot de passe est redemandé à chaque action chiffrée.'
          : reAuthStrict
            ? `Bon niveau : votre mot de passe reste valide ${currentReAuthMinutes} min avant d’être redemandé.`
            : `Confort privilégié : votre mot de passe reste valide ${currentReAuthMinutes} min avant d’être redemandé. Réduisez à 5 min ou moins pour renforcer la sécurité.`;

    const saveReAuth = useCallback(async (minutes: number) => {
        const res = await ws.send('secrecy.setReauth', { seconds: minutes * 60 });
        setSecrecy(res.status);
        // Keep the global unlock store in sync: switching to/from 0 changes the
        // "validate on every action" mode, which governs whether actions re-prompt.
        void refreshSecrecyStatus();
    }, []);

    const stepUpMinutes = stepUp?.minutes ?? 15;
    const stepUpReady = stepUp?.twoFactor === true;

    return (
        <div className={styles.container}>
            <StickyHeader>
                <h2 className={styles.title}>Sécurité</h2>
                <p className={styles.subtitle}>
                    Protégez votre compte et vos données avec des couches de sécurité supplémentaires
                </p>
            </StickyHeader>

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
                                {status?.enabled ? (
                                    `${status.backupCodesRemaining} codes de secours restants`
                                ) : (
                                    <>
                                        Activez la <Term id='twoFactor'>2FA</Term> pour sécuriser votre compte
                                    </>
                                )}
                            </p>
                        </div>
                        <div className={styles.statusControls}>
                            <div className={styles.infoSlot}>
                                <button
                                    className={styles.infoBtn}
                                    onClick={showTwoFactorInfo}
                                    title='Comment ça fonctionne ?'
                                >
                                    <span className='icon icon-info' />
                                </button>
                            </div>
                            {extraColumn && (
                                <div className={styles.extraSlot}>
                                    <button
                                        className={styles.resetBtn}
                                        onClick={openRegenConfirm}
                                        title='Régénérer les codes de secours'
                                    >
                                        <span className='icon icon-refresh' />
                                    </button>
                                </div>
                            )}
                            <div className={styles.actionSlot}>
                                {!status?.enabled ? (
                                    <Button onClick={startSetup}>Activer</Button>
                                ) : (
                                    <Button variant='danger' onClick={openDisableConfirm}>
                                        Désactiver
                                    </Button>
                                )}
                            </div>
                        </div>
                    </div>

                    <div className={styles.statusCard}>
                        <div className={`${styles.statusIcon} ${stepUpReady ? styles.enabled : ''}`}>
                            <span className='icon icon-shield' />
                        </div>
                        <div className={styles.statusInfo}>
                            <h3>
                                {stepUpReady
                                    ? `Pilotage des machines : code redemandé après ${stepUpMinutes} min`
                                    : 'Pilotage des machines'}
                            </h3>
                            <p>
                                {stepUpReady
                                    ? 'Le code de votre application est demandé avant d’agir sur une machine, puis après ce délai sans y toucher.'
                                    : 'Activez la 2FA : piloter une machine (terminal, fichiers, mises à jour) demande le code de votre application.'}
                            </p>
                        </div>
                        <div className={styles.statusControls}>
                            <div className={styles.infoSlot}>
                                <button
                                    className={styles.infoBtn}
                                    onClick={showStepUpInfo}
                                    title='Comment ça fonctionne ?'
                                >
                                    <span className='icon icon-info' />
                                </button>
                            </div>
                            {extraColumn && <div className={styles.extraSlot} />}
                            <div className={styles.actionSlot}>
                                {!stepUpReady ? (
                                    <span className={styles.rowOff}>Sans 2FA</span>
                                ) : (
                                    <MinutesEditor
                                        value={stepUpMinutes}
                                        min={STEP_UP_MINUTES_MIN}
                                        max={STEP_UP_MINUTES_MAX}
                                        onSave={saveStepUpMinutes}
                                        aria-label='Délai avant de redemander le code, en minutes'
                                    />
                                )}
                            </div>
                        </div>
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
                        <div className={styles.statusControls}>
                            <div className={styles.infoSlot}>
                                <button
                                    className={styles.infoBtn}
                                    onClick={showEncryptionInfo}
                                    title='Comment ça fonctionne ?'
                                >
                                    <span className='icon icon-info' />
                                </button>
                            </div>
                            {extraColumn && <div className={styles.extraSlot} />}
                            <div className={styles.actionSlot}>
                                <Button
                                    variant={secrecy?.enabled ? 'danger' : 'primary'}
                                    onClick={() => setSecurityOpen(true)}
                                >
                                    {secrecy?.enabled ? 'Désactiver' : 'Activer'}
                                </Button>
                            </div>
                        </div>
                    </div>

                    <div className={styles.statusCard}>
                        <div className={`${styles.statusIcon} ${reAuthStrict ? styles.enabled : ''}`}>
                            <span className='icon icon-shield' />
                        </div>
                        <div className={styles.statusInfo}>
                            <h3>{reAuthTitle}</h3>
                            <p>{reAuthDescription}</p>
                        </div>
                        {/* Sans chiffrement par mot de passe, ce délai ne gouverne rien :
                            plutôt qu'un champ grisé qu'on peut croire réparable, un mot
                            qui dit l'état. Le « pourquoi » est déjà dans la description
                            juste au-dessus, l'aide contextuelle n'a plus rien à ajouter. */}
                        <div className={styles.statusControls}>
                            <div className={styles.infoSlot}>
                                {encryptionEnabled && (
                                    <button
                                        className={styles.infoBtn}
                                        onClick={showReauthInfo}
                                        title='Comment ça fonctionne ?'
                                    >
                                        <span className='icon icon-info' />
                                    </button>
                                )}
                            </div>
                            {extraColumn && <div className={styles.extraSlot} />}
                            <div className={styles.actionSlot}>
                                {!encryptionEnabled ? (
                                    <span className={styles.rowOff}>Désactivé</span>
                                ) : (
                                    <MinutesEditor
                                        value={currentReAuthMinutes}
                                        min={0}
                                        max={1440}
                                        onSave={saveReAuth}
                                        aria-label='Délai de validation en minutes'
                                    />
                                )}
                            </div>
                        </div>
                    </div>

                    {error && <div className={styles.error}>{error}</div>}

                    <Dialog
                        open={setupOpen}
                        onClose={closeSetup}
                        title='Configurer la 2FA'
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
                        title='Désactiver la 2FA'
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
