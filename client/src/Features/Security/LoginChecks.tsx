import { useState } from 'react';

import type { LoginChecksStatus } from '@deveye/types';

import { ws, WsError } from '@/api/ws';
import Button from '@/Components/Button';
import { Dialog } from '@/Components/Dialog';
import { openInfo } from '@/Components/InfoPopup';
import TextInput from '@/Components/TextInput';
import { PhoneDialog } from './PhoneDialog';
import styles from './Security.module.css';

interface RowProps {
    checks: LoginChecksStatus;
    onChange: (checks: LoginChecksStatus) => void;
    /** Les cartes alignent leurs colonnes : l'emplacement du geste secondaire existe chez toutes ou chez aucune. */
    extraColumn: boolean;
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
                    code pendant 90 jours après sa dernière connexion. Vous pouvez le retirer à tout moment ici.
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

/** La confirmation par mail, en tête de la page : la protection qui s'applique à toute connexion. */
export function EmailCheckRow({ checks, onChange, extraColumn }: RowProps) {
    const [disableOpen, setDisableOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const { email } = checks;

    const enable = async () => {
        setBusy(true);
        try {
            onChange((await ws.send('loginChecks.setEmail', { enabled: true })).status);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className={styles.statusCard}>
            <div className={`${styles.statusIcon} ${email.enabled ? styles.enabled : ''}`}>
                <span className='icon icon-mail' />
            </div>
            <div className={styles.statusInfo}>
                <h3>{email.enabled ? 'Code par mail activé' : 'Code par mail désactivé'}</h3>
                <p>
                    {email.enabled
                        ? `Une connexion depuis un nouveau navigateur demande un code envoyé à ${email.to}.`
                        : 'Activez-le : un mot de passe volé ne suffira plus pour entrer depuis un autre navigateur.'}
                </p>
            </div>
            <div className={styles.statusControls}>
                <div className={styles.infoSlot}>
                    <button className={styles.infoBtn} onClick={showEmailCheckInfo} title='Comment ça fonctionne ?'>
                        <span className='icon icon-info' />
                    </button>
                </div>
                {extraColumn && <div className={styles.extraSlot} />}
                <div className={styles.actionSlot}>
                    {email.enabled ? (
                        <Button variant='danger' onClick={() => setDisableOpen(true)}>
                            Désactiver
                        </Button>
                    ) : (
                        <Button onClick={() => void enable()} disabled={busy}>
                            Activer
                        </Button>
                    )}
                </div>
            </div>
            <PasswordConfirmDialog
                open={disableOpen}
                onClose={() => setDisableOpen(false)}
                title='Désactiver le code par mail'
                description='⚠️ Votre mot de passe suffira de nouveau pour entrer depuis n’importe quel navigateur. Saisissez-le pour confirmer.'
                onConfirm={async (password) =>
                    onChange((await ws.send('loginChecks.setEmail', { enabled: false, password })).status)
                }
            />
        </div>
    );
}

/** Le code par SMS : un numéro vérifié d'abord, puis la protection qu'il porte. */
export function SmsCheckRow({ checks, onChange, extraColumn }: RowProps) {
    const [phoneOpen, setPhoneOpen] = useState(false);
    const [disableOpen, setDisableOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const { sms } = checks;

    const enable = async () => {
        setBusy(true);
        try {
            onChange((await ws.send('loginChecks.setSms', { enabled: true })).status);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className={styles.statusCard}>
            <div className={`${styles.statusIcon} ${sms.enabled ? styles.enabled : ''}`}>
                <span className='icon icon-phone' />
            </div>
            <div className={styles.statusInfo}>
                <h3>{sms.enabled ? 'Code par SMS activé' : 'Code par SMS désactivé'}</h3>
                <p>
                    {!sms.phone
                        ? 'Ajoutez votre numéro : un code par SMS confirmera chaque connexion depuis un nouveau navigateur.'
                        : sms.enabled
                          ? `Une connexion depuis un nouveau navigateur demande aussi un code envoyé au ${sms.phone}.`
                          : `Activez-le pour recevoir un code au ${sms.phone} à chaque connexion depuis un nouveau navigateur.`}
                    {sms.phone && (
                        <button type='button' className={styles.inlineLink} onClick={() => setPhoneOpen(true)}>
                            Changer de numéro
                        </button>
                    )}
                </p>
            </div>
            <div className={styles.statusControls}>
                <div className={styles.infoSlot}>
                    <button className={styles.infoBtn} onClick={showSmsCheckInfo} title='Comment ça fonctionne ?'>
                        <span className='icon icon-info' />
                    </button>
                </div>
                {extraColumn && <div className={styles.extraSlot} />}
                <div className={styles.actionSlot}>
                    {!sms.phone ? (
                        <Button onClick={() => setPhoneOpen(true)}>Ajouter un numéro</Button>
                    ) : sms.enabled ? (
                        <Button variant='danger' onClick={() => setDisableOpen(true)}>
                            Désactiver
                        </Button>
                    ) : (
                        <Button onClick={() => void enable()} disabled={busy}>
                            Activer
                        </Button>
                    )}
                </div>
            </div>
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
        </div>
    );
}

/** Les navigateurs qui sautent les codes, et de quoi leur retirer cette confiance. */
export function TrustedBrowsersCard({ checks, onChange, extraColumn }: RowProps) {
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
        <div className={styles.statusCard}>
            <div className={styles.statusIcon}>
                <span className='icon icon-shield' />
            </div>
            <div className={styles.statusInfo}>
                <h3>Navigateurs de confiance</h3>
                <p>
                    {browsers.length === 0
                        ? 'Aucun : chaque nouvelle connexion demande un code.'
                        : browsers.length === 1
                          ? 'Un navigateur se connecte sans code. Retirez-le si vous ne le reconnaissez pas.'
                          : `${browsers.length} navigateurs se connectent sans code. Retirez ceux que vous ne reconnaissez pas.`}
                </p>
            </div>
            <div className={styles.statusControls}>
                <div className={styles.infoSlot} />
                {extraColumn && <div className={styles.extraSlot} />}
                <div className={styles.actionSlot}>
                    {browsers.length > 0 && (
                        <Button
                            variant='secondary'
                            disabled={busy}
                            onClick={() => void run(() => ws.send('loginChecks.forgetBrowsers', {}))}
                        >
                            Tout retirer
                        </Button>
                    )}
                </div>
            </div>
            {browsers.length > 0 && (
                <ul className={styles.browserList}>
                    {browsers.map((browser) => (
                        <li key={browser.id} className={styles.browserItem}>
                            <div className={styles.browserText}>
                                <span className={styles.browserLabel}>{browser.label}</span>
                                <span className={styles.browserMeta}>
                                    Dernière connexion le {formatDay(browser.lastUsedAt)}
                                </span>
                            </div>
                            <Button
                                variant='ghost'
                                disabled={busy}
                                onClick={() => void run(() => ws.send('loginChecks.forgetBrowser', { id: browser.id }))}
                            >
                                Retirer
                            </Button>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
