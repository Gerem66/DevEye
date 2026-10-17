import { useCallback, useEffect, useState } from 'react';

import {
    LOGIN_HISTORY_WINDOW_DAYS,
    TRUSTED_BROWSER_DAYS,
    TRUSTED_BROWSERS_MAX,
    type LoginChecksStatus,
    type LoginEntry,
    type LoginStep,
    type TrustedBrowser
} from '@deveye/types';

import { ws, WsError } from '@/api/ws';
import { humanizeError } from '@/api/useResource';
import Button from '@/Components/Button';
import { ConfirmDialog, type ConfirmRequest } from '@/Components/ConfirmDialog';
import { Dialog } from '@/Components/Dialog';
import { openInfo } from '@/Components/InfoPopup';
import { StatusBadge } from '@/Components/StatusBadge';
import Switch from '@/Components/Switch';
import TextInput from '@/Components/TextInput';
import { PhoneDialog } from './PhoneDialog';
import { Row } from './Row';
import styles from './Security.module.css';

interface RowProps {
    checks: LoginChecksStatus;
    onChange: (checks: LoginChecksStatus) => void;
}

function showEmailCheckInfo() {
    void openInfo({
        title: 'Code par mail aux nouveaux navigateurs',
        body: (
            <>
                <p>
                    Quand quelqu&apos;un se connecte à votre compte depuis un navigateur que DevEye ne connaît pas, un
                    code à 6 chiffres part à votre adresse. Sans lui, la connexion ne s&apos;ouvre pas : un mot de passe
                    volé ne suffit plus.
                </p>
                <p>
                    Le mail part dès le mot de passe validé. Même si votre double authentification arrête l&apos;intrus,
                    vous apprenez que votre mot de passe est connu.
                </p>
                <p>
                    En cochant « Faire confiance à ce navigateur » à la connexion, ce navigateur ne redemande plus le
                    code pendant {TRUSTED_BROWSER_DAYS} jours après sa dernière connexion. Vous pouvez le retirer à tout
                    moment ici.
                </p>
            </>
        )
    });
}

function showSmsCheckInfo() {
    void openInfo({
        title: 'Code par SMS aux nouveaux navigateurs',
        body: (
            <>
                <p>
                    Comme le code par mail, mais sur votre téléphone : une connexion depuis un navigateur que DevEye ne
                    connaît pas demande un code reçu par SMS. Il s&apos;ajoute au code par mail et à votre application
                    d&apos;authentification, il ne les remplace pas.
                </p>
                <p>
                    Votre numéro ne sert qu&apos;à cela. Il est chiffré sur le serveur, et transmis à OVHcloud, qui
                    envoie le SMS. Le changer ou le retirer demande votre mot de passe.
                </p>
            </>
        )
    });
}

/**
 * Le mot de passe avant de baisser une protection : une session volée ne la
 * coupe pas seule.
 */
function PasswordConfirmDialog({
    open,
    title,
    description,
    onClose,
    onConfirm
}: {
    open: boolean;
    title: string;
    description: string;
    onClose: () => void;
    onConfirm: (password: string) => Promise<void>;
}) {
    const [password, setPassword] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const confirm = async () => {
        if (!password || busy) return;
        setBusy(true);
        setError(null);
        try {
            await onConfirm(password);
            setPassword('');
            onClose();
        } catch (e) {
            setPassword('');
            setError(
                e instanceof WsError && e.code === 'auth_invalid'
                    ? 'Mot de passe incorrect'
                    : 'Échec de la désactivation'
            );
        } finally {
            setBusy(false);
        }
    };

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title={title}
            description={description}
            onSubmit={() => void confirm()}
            footer={
                <>
                    <Button variant='ghost' onClick={onClose} disabled={busy}>
                        Annuler
                    </Button>
                    <Button variant='danger' onClick={() => void confirm()} disabled={!password || busy}>
                        Désactiver
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
                onChange={(e) => {
                    setPassword(e.target.value);
                    setError(null);
                }}
            />
        </Dialog>
    );
}

function formatDay(seconds: number): string {
    return new Date(seconds * 1000).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
}

/** « 16 octobre à 14:32 » : l'année est celle en cours, la fenêtre ne remonte pas plus loin. */
function formatMoment(seconds: number): string {
    const date = new Date(seconds * 1000);
    const day = date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });
    const time = date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    return `${day} à ${time}`;
}

const STEP_LABELS: Record<LoginStep, string> = {
    email: 'code par mail',
    totp: 'code de l’application',
    sms: 'code par SMS'
};

/** Ce qu'une connexion a franchi après le mot de passe, en une poignée de mots. */
function stepsLabel(entry: LoginEntry): string {
    if (entry.steps.length > 0) return entry.steps.map((s) => STEP_LABELS[s]).join(', ');
    return entry.trusted ? 'navigateur de confiance' : 'mot de passe seul';
}

/** Le code par mail : la protection qui s'applique à toute connexion. */
export function EmailCheckRow({ checks, onChange }: RowProps) {
    const [disableOpen, setDisableOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const { email } = checks;

    // Allumer ne demande rien : l'interrupteur bascule aussitôt, et revient si
    // le serveur refuse.
    const enable = async () => {
        setBusy(true);
        setError(null);
        onChange({ ...checks, email: { ...email, enabled: true } });
        try {
            onChange((await ws.send('loginChecks.setEmail', { enabled: true })).status);
        } catch (e) {
            onChange(checks);
            setError(humanizeError(e, 'Le code par mail n’a pas pu être activé.'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            <Row
                label='Code par mail'
                icon='mail'
                tone={email.enabled ? 'accent' : undefined}
                onInfo={showEmailCheckInfo}
                error={error}
                hint={
                    email.enabled
                        ? `Un code envoyé à ${email.to} confirme chaque connexion depuis un nouveau navigateur.`
                        : 'Un mot de passe volé ne suffira plus pour entrer depuis un autre navigateur.'
                }
            >
                <Switch
                    checked={email.enabled}
                    disabled={busy}
                    aria-label='Code par mail à la connexion'
                    onChange={(on) => {
                        if (on) void enable();
                        else setDisableOpen(true);
                    }}
                />
            </Row>
            <PasswordConfirmDialog
                open={disableOpen}
                onClose={() => setDisableOpen(false)}
                title='Désactiver le code par mail'
                description='⚠️ Votre mot de passe suffira de nouveau pour entrer depuis n’importe quel navigateur. Saisissez-le pour confirmer.'
                onConfirm={async (password) =>
                    onChange((await ws.send('loginChecks.setEmail', { enabled: false, password })).status)
                }
            />
        </>
    );
}

/** Le code par SMS : un numéro vérifié d'abord, puis la protection qu'il porte. */
export function SmsCheckRow({ checks, onChange }: RowProps) {
    const [phoneOpen, setPhoneOpen] = useState(false);
    const [disableOpen, setDisableOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const { sms } = checks;

    const enable = async () => {
        setBusy(true);
        setError(null);
        onChange({ ...checks, sms: { ...sms, enabled: true } });
        try {
            onChange((await ws.send('loginChecks.setSms', { enabled: true })).status);
        } catch (e) {
            onChange(checks);
            setError(humanizeError(e, 'Le code par SMS n’a pas pu être activé.'));
        } finally {
            setBusy(false);
        }
    };

    // Sans numéro, allumer commence par en vérifier un : le code reçu l'active.
    const toggle = (on: boolean) => {
        if (!on) setDisableOpen(true);
        else if (!sms.phone) setPhoneOpen(true);
        else void enable();
    };

    return (
        <>
            <Row
                label='Code par SMS'
                icon='phone'
                tone={sms.enabled ? 'accent' : undefined}
                onInfo={showSmsCheckInfo}
                error={error}
                hint={
                    <>
                        {!sms.phone
                            ? 'Activez-le pour ajouter votre numéro : un code par SMS confirmera aussi chaque connexion depuis un nouveau navigateur.'
                            : sms.enabled
                              ? `Un code envoyé au ${sms.phone} confirme aussi chaque connexion depuis un nouveau navigateur.`
                              : `Un code au ${sms.phone} confirmera aussi chaque connexion depuis un nouveau navigateur.`}
                        {sms.phone && (
                            <button type='button' className={styles.inlineLink} onClick={() => setPhoneOpen(true)}>
                                Changer de numéro
                            </button>
                        )}
                    </>
                }
            >
                <Switch
                    checked={sms.enabled}
                    disabled={busy}
                    aria-label='Code par SMS à la connexion'
                    onChange={toggle}
                />
            </Row>
            <PhoneDialog open={phoneOpen} current={sms.phone} onClose={() => setPhoneOpen(false)} onChange={onChange} />
            <PasswordConfirmDialog
                open={disableOpen}
                onClose={() => setDisableOpen(false)}
                title='Désactiver le code par SMS'
                description='Les connexions depuis un nouveau navigateur ne demanderont plus de code par SMS. Saisissez votre mot de passe pour confirmer.'
                onConfirm={async (password) =>
                    onChange((await ws.send('loginChecks.setSms', { enabled: false, password })).status)
                }
            />
        </>
    );
}

interface TrustedBrowsersDialogProps {
    open: boolean;
    browsers: TrustedBrowser[];
    onClose: () => void;
    onChange: (checks: LoginChecksStatus) => void;
}

/** La liste des navigateurs qui sautent les codes, et de quoi leur retirer cette confiance, un par un ou tous. */
function TrustedBrowsersDialog({ open, browsers, onClose, onChange }: TrustedBrowsersDialogProps) {
    const [busy, setBusy] = useState(false);
    const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

    const run = async (send: () => Promise<{ status: LoginChecksStatus }>) => {
        setBusy(true);
        try {
            onChange((await send()).status);
        } finally {
            setBusy(false);
        }
    };

    // Plus rien à montrer : le dialogue se referme de lui-même.
    useEffect(() => {
        if (open && browsers.length === 0) onClose();
    }, [open, browsers.length, onClose]);

    const forgetOne = (browser: TrustedBrowser) =>
        setConfirm({
            title: 'Retirer ce navigateur ?',
            description: `« ${browser.label} » redemandera un code à sa prochaine connexion.`,
            confirmLabel: 'Retirer',
            onConfirm: () => void run(() => ws.send('loginChecks.forgetBrowser', { id: browser.id }))
        });

    const forgetAll = () =>
        setConfirm({
            title: 'Retirer tous les navigateurs ?',
            description: 'Chacun redemandera un code à sa prochaine connexion, celui-ci compris.',
            confirmLabel: 'Tout retirer',
            onConfirm: () => void run(() => ws.send('loginChecks.forgetBrowsers', {}))
        });

    return (
        <>
            <Dialog
                open={open}
                onClose={onClose}
                title='Navigateurs de confiance'
                description={`Ils entrent sans code pendant ${TRUSTED_BROWSER_DAYS} jours après leur dernière connexion. Retirez ceux que vous ne reconnaissez pas.`}
                width={560}
                footer={
                    <>
                        <Button variant='danger' disabled={busy} onClick={forgetAll}>
                            Tout retirer
                        </Button>
                        <Button variant='secondary' onClick={onClose}>
                            Fermer
                        </Button>
                    </>
                }
            >
                <ul className={styles.browserList}>
                    {browsers.map((browser) => (
                        <li key={browser.id} className={styles.browserItem}>
                            <span className={styles.browserText}>
                                <span className={styles.browserLabel}>{browser.label}</span>
                                <span className={styles.browserMeta}>
                                    Dernière connexion le {formatDay(browser.lastUsedAt)}
                                </span>
                            </span>
                            <Button variant='ghost' disabled={busy} onClick={() => forgetOne(browser)}>
                                Retirer
                            </Button>
                        </li>
                    ))}
                </ul>
            </Dialog>
            <ConfirmDialog request={confirm} busy={busy} onClose={() => setConfirm(null)} />
        </>
    );
}

/** Les navigateurs qui sautent les codes : leur nombre, et le dialogue qui les retire. */
export function TrustedBrowsersRow({ checks, onChange }: RowProps) {
    const [open, setOpen] = useState(false);
    const close = useCallback(() => setOpen(false), []);
    const { browsers } = checks;
    const count = browsers.length;
    const hint =
        count === 0
            ? 'Aucun : chaque connexion depuis un nouveau navigateur demande un code.'
            : count <= TRUSTED_BROWSERS_MAX
              ? `Ils entrent sans code pendant ${TRUSTED_BROWSER_DAYS} jours après leur dernière connexion.`
              : `Ils entrent sans code pendant ${TRUSTED_BROWSER_DAYS} jours après leur dernière connexion. Plus de ${TRUSTED_BROWSERS_MAX}, c’est beaucoup : retirez ceux que vous n’utilisez plus.`;

    return (
        <>
            <Row sub icon='globe' label='Navigateurs de confiance' hint={hint}>
                {count > 0 ? (
                    <Button variant='secondary' onClick={() => setOpen(true)}>
                        {count} navigateur{count > 1 ? 's' : ''}
                    </Button>
                ) : (
                    <span className={styles.rowNone}>Aucun</span>
                )}
            </Row>
            <TrustedBrowsersDialog open={open} browsers={browsers} onClose={close} onChange={onChange} />
        </>
    );
}

interface LoginHistoryDialogProps {
    open: boolean;
    onClose: () => void;
}

/**
 * Les connexions réussies des derniers jours, en lecture seule : ce qu'on
 * regarde quand on soupçonne une connexion depuis un appareil qui n'est pas
 * le sien. Le geste qui va avec : fermer les autres sessions.
 */
function LoginHistoryDialog({ open, onClose }: LoginHistoryDialogProps) {
    const [history, setHistory] = useState<{ entries: LoginEntry[]; older: number } | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
    const [busy, setBusy] = useState(false);
    /** Le résultat de la fermeture, le temps que le dialogue reste ouvert. */
    const [closed, setClosed] = useState<number | null>(null);

    useEffect(() => {
        if (!open) return;
        setHistory(null);
        setError(null);
        setClosed(null);
        ws.send('loginChecks.history', {}).then(setHistory, (e: unknown) =>
            setError(humanizeError(e, 'L’historique n’a pas pu être lu.'))
        );
    }, [open]);

    const logoutOthers = async () => {
        setBusy(true);
        try {
            setClosed((await ws.send('loginChecks.logoutOthers', {})).closed);
        } catch (e) {
            setError(humanizeError(e, 'Les autres appareils n’ont pas pu être déconnectés.'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            <Dialog
                open={open}
                onClose={onClose}
                title='Connexions récentes'
                description={`Chaque ouverture de session des ${LOGIN_HISTORY_WINDOW_DAYS} derniers jours, avec le navigateur et l’adresse d’où elle venait. Une connexion que vous ne reconnaissez pas : changez votre mot de passe et déconnectez les autres appareils.`}
                width={600}
                footer={
                    <>
                        <Button
                            variant='danger'
                            disabled={busy || closed !== null}
                            onClick={() =>
                                setConfirm({
                                    title: 'Déconnecter les autres appareils ?',
                                    description:
                                        'Toutes vos sessions se ferment, sauf celle-ci. Chaque appareil devra se reconnecter avec votre mot de passe.',
                                    confirmLabel: 'Déconnecter',
                                    onConfirm: () => void logoutOthers()
                                })
                            }
                        >
                            Déconnecter les autres appareils
                        </Button>
                        <Button variant='secondary' onClick={onClose}>
                            Fermer
                        </Button>
                    </>
                }
            >
                {error ? (
                    <div className={styles.error} role='alert'>
                        {error}
                    </div>
                ) : history === null ? (
                    <p className={styles.historyNote}>Chargement…</p>
                ) : (
                    <>
                        <ul className={styles.browserList}>
                            {history.entries.map((entry) => (
                                <li key={entry.id} className={styles.browserItem}>
                                    <span className={styles.browserText}>
                                        <span className={styles.browserLabel}>
                                            {entry.label}
                                            {entry.current && (
                                                <StatusBadge tone='accent' dot={false} className={styles.historyTag}>
                                                    Celle-ci
                                                </StatusBadge>
                                            )}
                                            {entry.trusted && (
                                                <StatusBadge tone='neutral' dot={false} className={styles.historyTag}>
                                                    De confiance
                                                </StatusBadge>
                                            )}
                                        </span>
                                        <span className={styles.browserMeta}>
                                            Le {formatMoment(entry.at)} · {entry.ip} · {stepsLabel(entry)}
                                        </span>
                                    </span>
                                </li>
                            ))}
                        </ul>
                        {history.older > 0 && (
                            <p className={styles.historyNote}>
                                Et {history.older} connexion{history.older > 1 ? 's' : ''} plus ancienne
                                {history.older > 1 ? 's' : ''}.
                            </p>
                        )}
                        {closed !== null && (
                            <p className={styles.historyDone} role='status'>
                                {closed === 0
                                    ? 'Aucune autre session n’était ouverte.'
                                    : `${closed} autre${closed > 1 ? 's' : ''} session${closed > 1 ? 's' : ''} fermée${closed > 1 ? 's' : ''}.`}
                            </p>
                        )}
                    </>
                )}
            </Dialog>
            <ConfirmDialog request={confirm} busy={busy} onClose={() => setConfirm(null)} />
        </>
    );
}

/** Les connexions récentes : leur nombre, et le dialogue qui les montre. */
export function LoginHistoryRow({ checks }: Pick<RowProps, 'checks'>) {
    const [open, setOpen] = useState(false);
    const close = useCallback(() => setOpen(false), []);
    const count = checks.recentLogins;
    return (
        <>
            <Row
                sub
                icon='clock'
                label='Connexions récentes'
                hint={`Chaque ouverture de session des ${LOGIN_HISTORY_WINDOW_DAYS} derniers jours, avec son navigateur et son adresse : de quoi repérer un appareil qui n’est pas le vôtre.`}
            >
                <Button variant='secondary' onClick={() => setOpen(true)}>
                    {count} connexion{count > 1 ? 's' : ''}
                </Button>
            </Row>
            <LoginHistoryDialog open={open} onClose={close} />
        </>
    );
}
