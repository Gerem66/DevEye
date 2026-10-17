import { useState } from 'react';

import { TRUSTED_BROWSER_DAYS, type LoginChecksStatus } from '@deveye/types';

import { ws, WsError } from '@/api/ws';
import { humanizeError } from '@/api/useResource';
import Button from '@/Components/Button';
import { Dialog } from '@/Components/Dialog';
import { openInfo } from '@/Components/InfoPopup';
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
                active={email.enabled}
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
                active={sms.enabled}
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

/** Les navigateurs qui sautent les codes, et de quoi leur retirer cette confiance. */
export function TrustedBrowsersRow({ checks, onChange }: RowProps) {
    const [busy, setBusy] = useState(false);
    const { browsers } = checks;

    const run = async (send: () => Promise<{ status: LoginChecksStatus }>) => {
        setBusy(true);
        try {
            onChange((await send()).status);
        } finally {
            setBusy(false);
        }
    };

    return (
        <Row
            sub
            label='Navigateurs de confiance'
            hint={
                browsers.length === 0
                    ? 'Aucun : chaque connexion depuis un nouveau navigateur demande un code.'
                    : `Ils entrent sans code pendant ${TRUSTED_BROWSER_DAYS} jours après leur dernière connexion. Retirez ceux que vous ne reconnaissez pas.`
            }
            below={
                browsers.length > 0 && (
                    <ul className={styles.browserList}>
                        {browsers.map((browser) => (
                            <li key={browser.id} className={styles.browserItem}>
                                <span className={styles.browserText}>
                                    <span className={styles.browserLabel}>{browser.label}</span>
                                    <span className={styles.browserMeta}>
                                        Dernière connexion le {formatDay(browser.lastUsedAt)}
                                    </span>
                                </span>
                                <Button
                                    variant='ghost'
                                    disabled={busy}
                                    onClick={() =>
                                        void run(() => ws.send('loginChecks.forgetBrowser', { id: browser.id }))
                                    }
                                >
                                    Retirer
                                </Button>
                            </li>
                        ))}
                    </ul>
                )
            }
        >
            {browsers.length > 1 && (
                <Button
                    variant='secondary'
                    disabled={busy}
                    onClick={() => void run(() => ws.send('loginChecks.forgetBrowsers', {}))}
                >
                    Tout retirer
                </Button>
            )}
        </Row>
    );
}
