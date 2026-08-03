import { useRef, useState } from 'react';

import Button from '@/Components/Button';
import { DialogCancelButton } from '@/Components/Dialog';
import Popup, { ClosePopup } from '@/Components/Popup';
import TextInput from '@/Components/TextInput';
import { MAIL_SYNC_INTERVAL_DEFAULT_MINUTES } from 'deveye-types';
import { humanizeError, ws } from './api';
import styles from './style.module.css';

import type {
    MailAccount,
    MailAccountDraft,
    MailAccountEdit,
    MailAuthMethod,
    MailOAuthProvider,
    MailProxy,
    MailSecurityTier
} from 'deveye-types';

export const ACCOUNT_POPUP = 'popup-mail-account';

export type AccountPopupResult = 'delete' | 'saved' | 'oauth-connected' | null;

const DEFAULT_DRAFT: MailAccountDraft = {
    displayName: '',
    emailAddress: '',
    securityTier: 'open',
    imap: { host: '', port: 993, username: '', password: '' },
    smtp: { host: '', port: 465, username: '', password: '' },
    proxy: null
};

/**
 * Add / edit form for a mail account. OAuth accounts (Gmail/Microsoft) are
 * created entirely server-side via the popup-window consent flow — this form
 * only drives password-auth accounts, plus the "Connect with..." buttons that
 * kick off OAuth for a brand new account. The Fournisseurs/Connexion manuelle
 * tabs stay in the same two spots in both modes for consistency, and editing a
 * password account lands straight on the manual tab.
 *
 * Opening an **OAuth** account here is read-only: its settings live with the
 * provider and `mail.accountUpdate` rejects it outright, so the form is locked
 * and only the delete action stays live. It still has to open, though — the
 * delete button lives nowhere else, so gating this popup on auth method used to
 * leave an OAuth mailbox with no way to remove it at all.
 */
export function AccountPopup() {
    const [mode, setMode] = useState<'add' | 'edit'>('add');
    const [tab, setTab] = useState<'providers' | 'manual'>('providers');
    const [authMethod, setAuthMethod] = useState<MailAuthMethod>('password');
    /** Owned by the account's options panel, not by this form — resubmitted unchanged. */
    const [syncIntervalMinutes, setSyncIntervalMinutes] = useState(MAIL_SYNC_INTERVAL_DEFAULT_MINUTES);
    const [accountId, setAccountId] = useState<number | null>(null);
    const [draft, setDraft] = useState<MailAccountDraft>(DEFAULT_DRAFT);
    const [proxyEnabled, setProxyEnabled] = useState(false);
    /** The account already had a proxy when the form opened (details unknown to us). */
    const [proxyPreconfigured, setProxyPreconfigured] = useState(false);
    /** The user actually went near the proxy controls — otherwise we send nothing about it. */
    const [proxyTouched, setProxyTouched] = useState(false);
    const [errorName, setErrorName] = useState('');
    const [errorEmail, setErrorEmail] = useState('');
    const [testResult, setTestResult] = useState<string | null>(null);
    const [testing, setTesting] = useState(false);
    const [oauthBusy, setOauthBusy] = useState<MailOAuthProvider | null>(null);
    const initial = useRef<MailAccountDraft>(DEFAULT_DRAFT);
    /**
     * An OAuth mailbox: its servers and secrets belong to the provider, so the
     * manual form is out — but the label, the storage tier and the proxy are
     * ours either way, and stay editable through `mail.accountSetProfile`.
     */
    const providerManaged = mode === 'edit' && authMethod !== 'password';
    const showManualFields = !providerManaged && tab === 'manual';
    const showProxyFields = showManualFields || providerManaged;

    function set<K extends keyof MailAccountDraft>(key: K, value: MailAccountDraft[K]): void {
        setDraft((prev) => ({ ...prev, [key]: value }));
    }

    function handleOpen(input: MailAccount | null): void {
        setTestResult(null);
        setErrorName('');
        setErrorEmail('');
        setAccountId(input?.id ?? null);
        setMode(input ? 'edit' : 'add');
        setAuthMethod(input?.authMethod ?? 'password');
        setSyncIntervalMinutes(input?.syncIntervalMinutes ?? MAIL_SYNC_INTERVAL_DEFAULT_MINUTES);
        // Land straight on the tab that has something to show: the manual form
        // for a password account, the provider notice for an OAuth one.
        setTab(input && input.authMethod === 'password' ? 'manual' : 'providers');
        const next: MailAccountDraft = input
            ? {
                  displayName: input.displayName,
                  emailAddress: input.emailAddress,
                  securityTier: input.securityTier,
                  imap: { host: input.imapHost, port: input.imapPort, username: '', password: '' },
                  smtp: { host: input.smtpHost, port: input.smtpPort, username: '', password: '' },
                  proxy: null
              }
            : DEFAULT_DRAFT;
        setDraft(next);
        setProxyEnabled(input?.proxyConfigured ?? false);
        setProxyPreconfigured(input?.proxyConfigured ?? false);
        setProxyTouched(false);
        initial.current = next;
    }

    const dirty = JSON.stringify(draft) !== JSON.stringify(initial.current);

    function close(result: AccountPopupResult = null): void {
        ClosePopup(ACCOUNT_POPUP, result);
    }

    function validate(): boolean {
        const name = draft.displayName.trim();
        setErrorName(name ? '' : 'Ce champ est obligatoire');
        // The address of a provider-managed account is the provider's, not an
        // input — there is nothing for the user to get wrong here.
        if (providerManaged) {
            setErrorEmail('');
            return Boolean(name);
        }
        const email = draft.emailAddress.trim();
        const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
        setErrorEmail(validEmail ? '' : 'Adresse invalide');
        return Boolean(name) && validEmail;
    }

    async function testConnection(): Promise<void> {
        if (!validate()) return;
        setTesting(true);
        setTestResult(null);
        try {
            const res = await ws.send('mail.accountTestConnection', accountId ? { id: accountId } : { draft });
            if (res.imapOk && res.smtpOk) setTestResult('Connexion IMAP et SMTP réussie.');
            else setTestResult(res.error ?? 'Échec de la connexion.');
        } catch (e) {
            setTestResult(humanizeError(e, 'Test impossible.'));
        } finally {
            setTesting(false);
        }
    }

    /** Proxy patch for `mail.accountSetProfile`: omitted entirely unless touched. */
    function proxyPatch(): { proxy?: MailProxy | null } {
        if (!proxyTouched) return {};
        return { proxy: proxyEnabled ? draft.proxy : null };
    }

    async function submit(): Promise<void> {
        if (!validate()) return;

        // A provider-managed account has no draft to submit — only the parts
        // that are ours, through the command that accepts exactly those.
        if (providerManaged && accountId !== null) {
            try {
                await ws.send('mail.accountSetProfile', {
                    id: accountId,
                    displayName: draft.displayName.trim(),
                    securityTier: draft.securityTier,
                    syncIntervalMinutes,
                    ...proxyPatch()
                });
                close('saved');
            } catch (e) {
                setTestResult(humanizeError(e, 'Enregistrement impossible.'));
            }
            return;
        }

        try {
            if (mode === 'edit' && accountId !== null) {
                // Blank credentials and an omitted proxy keep what's stored, so
                // renaming a mailbox doesn't mean retyping its secrets.
                const { proxy: _current, ...rest } = draft;
                const edit: MailAccountEdit = {
                    ...rest,
                    displayName: draft.displayName.trim(),
                    emailAddress: draft.emailAddress.trim(),
                    ...proxyPatch()
                };
                await ws.send('mail.accountUpdate', { id: accountId, draft: edit });
            } else {
                const payload: MailAccountDraft = {
                    ...draft,
                    displayName: draft.displayName.trim(),
                    emailAddress: draft.emailAddress.trim(),
                    proxy: proxyEnabled ? draft.proxy : null
                };
                await ws.send('mail.accountAdd', { draft: payload });
            }
            close('saved');
        } catch (e) {
            setTestResult(humanizeError(e, 'Enregistrement impossible.'));
        }
    }

    async function connectOAuth(provider: MailOAuthProvider): Promise<void> {
        setOauthBusy(provider);
        setTestResult(null);
        try {
            const res = await ws.send('mail.oauthStart', { provider, securityTier: draft.securityTier });
            const popup = window.open(res.authUrl, 'deveye-mail-oauth', 'width=520,height=680');
            if (!popup) throw new Error('Fenêtre bloquée par le navigateur — autorisez les popups pour DevEye.');
            await new Promise<void>((resolve, reject) => {
                let settled = false;
                function onMessage(e: MessageEvent) {
                    const data = e.data as { source?: string; ok?: boolean; error?: string } | undefined;
                    if (data?.source !== 'deveye-mail-oauth') return;
                    settled = true;
                    window.removeEventListener('message', onMessage);
                    clearInterval(poll);
                    if (data.ok) resolve();
                    else reject(new Error(data.error || 'Échec de connexion'));
                }
                const poll = window.setInterval(() => {
                    if (popup.closed && !settled) {
                        clearInterval(poll);
                        window.removeEventListener('message', onMessage);
                        reject(new Error('Fenêtre fermée avant la fin de la connexion.'));
                    }
                }, 500);
                window.addEventListener('message', onMessage);
            });
            close('oauth-connected');
        } catch (e) {
            setTestResult(e instanceof Error ? e.message : 'Échec de connexion.');
        } finally {
            setOauthBusy(null);
        }
    }

    return (
        <Popup
            id={ACCOUNT_POPUP}
            title={mode === 'add' ? 'Ajouter une boîte mail' : 'Modifier la boîte mail'}
            width={560}
            onInputChange={handleOpen}
            onClosePopup={() => close()}
            onSubmit={() => void submit()}
            dirty={dirty}
            onSave={() => void submit()}
        >
            <div className={styles.form}>
                <TextInput
                    placeholder='Nom (ex. Perso Gmail)'
                    value={draft.displayName}
                    error={errorName}
                    onChange={(e) => set('displayName', e.target.value)}
                />
                <TextInput
                    type='email'
                    placeholder='adresse@exemple.com'
                    value={draft.emailAddress}
                    error={errorEmail}
                    disabled={providerManaged}
                    onChange={(e) => set('emailAddress', e.target.value)}
                />

                <div className={styles.tierChoice}>
                    {(['open', 'guarded'] as MailSecurityTier[]).map((tier) => (
                        <label key={tier} className={styles.tierOption}>
                            <input
                                type='radio'
                                name='securityTier'
                                checked={draft.securityTier === tier}
                                onChange={() => set('securityTier', tier)}
                            />
                            <span>
                                <strong>{tier === 'open' ? 'Ouvert' : 'Protégé'}</strong>
                                <span className={styles.fieldHint}>
                                    {tier === 'open'
                                        ? 'Synchro automatique en tâche de fond, utilisable pour les notifications (ex. Uptime).'
                                        : 'Nécessite le déverrouillage par mot de passe à chaque consultation ; jamais synchronisé seul.'}
                                </span>
                            </span>
                        </label>
                    ))}
                </div>

                {/* An OAuth account has no second tab to offer: the manual form can't
                    describe it and can't save it either. */}
                {!providerManaged && (
                    <div className={styles.tabBar} role='tablist'>
                        <button
                            type='button'
                            role='tab'
                            aria-selected={tab === 'providers'}
                            className={`${styles.tabButton} ${tab === 'providers' ? styles.tabButtonActive : ''}`}
                            onClick={() => setTab('providers')}
                        >
                            Fournisseurs
                        </button>
                        <button
                            type='button'
                            role='tab'
                            aria-selected={tab === 'manual'}
                            className={`${styles.tabButton} ${tab === 'manual' ? styles.tabButtonActive : ''}`}
                            onClick={() => setTab('manual')}
                        >
                            Connexion manuelle
                        </button>
                    </div>
                )}

                {(providerManaged || tab === 'providers') && (
                    <div className={styles.oauthButtons}>
                        {providerManaged ? (
                            <span className={styles.fieldHint}>
                                Ce compte est connecté via {authMethod === 'oauth_google' ? 'Google' : 'Microsoft'} :
                                ses identifiants et ses serveurs sont gérés par le fournisseur, il n’y a rien à modifier
                                ici. Pour repartir de zéro, supprimez-le puis reconnectez-le.
                            </span>
                        ) : mode === 'add' ? (
                            <>
                                <Button
                                    variant='secondary'
                                    disabled={oauthBusy !== null}
                                    onClick={() => void connectOAuth('google')}
                                >
                                    {oauthBusy === 'google' ? 'Connexion…' : 'Se connecter avec Google'}
                                </Button>
                                <Button
                                    variant='secondary'
                                    disabled={oauthBusy !== null}
                                    onClick={() => void connectOAuth('microsoft')}
                                >
                                    {oauthBusy === 'microsoft' ? 'Connexion…' : 'Se connecter avec Microsoft'}
                                </Button>
                                <span className={styles.fieldHint}>
                                    Non configuré sur ce serveur ? Passez par l’onglet « Connexion manuelle ».
                                </span>
                            </>
                        ) : (
                            <span className={styles.fieldHint}>
                                Ce compte utilise une connexion manuelle — on ne peut pas le convertir en compte
                                Google/Microsoft après coup. Ajoutez plutôt une nouvelle boîte mail depuis cet onglet si
                                vous voulez vous connecter avec un fournisseur.
                            </span>
                        )}
                    </div>
                )}

                {showManualFields && (
                    <>
                        <p className={styles.sectionLabel}>IMAP (réception)</p>
                        <div className={styles.formRow}>
                            <TextInput
                                placeholder='imap.exemple.com'
                                value={draft.imap.host}
                                onChange={(e) => set('imap', { ...draft.imap, host: e.target.value })}
                            />
                            <TextInput
                                type='number'
                                placeholder='993'
                                value={draft.imap.port}
                                onChange={(e) => set('imap', { ...draft.imap, port: Number(e.target.value) || 993 })}
                            />
                        </div>
                        <div className={styles.formRow}>
                            <TextInput
                                placeholder='Identifiant'
                                value={draft.imap.username}
                                onChange={(e) => set('imap', { ...draft.imap, username: e.target.value })}
                            />
                            <TextInput
                                type='password'
                                placeholder={mode === 'edit' ? 'Nouveau mot de passe' : 'Mot de passe'}
                                value={draft.imap.password}
                                onChange={(e) => set('imap', { ...draft.imap, password: e.target.value })}
                            />
                        </div>

                        <p className={styles.sectionLabel}>SMTP (envoi)</p>
                        <div className={styles.formRow}>
                            <TextInput
                                placeholder='smtp.exemple.com'
                                value={draft.smtp.host}
                                onChange={(e) => set('smtp', { ...draft.smtp, host: e.target.value })}
                            />
                            <TextInput
                                type='number'
                                placeholder='465'
                                value={draft.smtp.port}
                                onChange={(e) => set('smtp', { ...draft.smtp, port: Number(e.target.value) || 465 })}
                            />
                        </div>
                        <div className={styles.formRow}>
                            <TextInput
                                placeholder='Identifiant'
                                value={draft.smtp.username}
                                onChange={(e) => set('smtp', { ...draft.smtp, username: e.target.value })}
                            />
                            <TextInput
                                type='password'
                                placeholder={mode === 'edit' ? 'Nouveau mot de passe' : 'Mot de passe'}
                                value={draft.smtp.password}
                                onChange={(e) => set('smtp', { ...draft.smtp, password: e.target.value })}
                            />
                        </div>
                    </>
                )}

                {showProxyFields && (
                    <>
                        <label className={styles.check}>
                            <input
                                type='checkbox'
                                checked={proxyEnabled}
                                onChange={(e) => {
                                    setProxyEnabled(e.target.checked);
                                    setProxyTouched(true);
                                    if (e.target.checked && !draft.proxy) {
                                        set('proxy', {
                                            kind: 'socks5',
                                            host: '',
                                            port: 1080,
                                            username: null,
                                            password: null
                                        });
                                    }
                                }}
                            />
                            <span>Passer par un proxy (SOCKS5/HTTP) — déjà géré par vous, DevEye n’en fournit pas</span>
                        </label>
                        {proxyEnabled && draft.proxy && (
                            <div className={styles.formRow}>
                                <TextInput
                                    placeholder='proxy.exemple.com'
                                    value={draft.proxy.host}
                                    onChange={(e) => {
                                        setProxyTouched(true);
                                        set('proxy', { ...draft.proxy!, host: e.target.value });
                                    }}
                                />
                                <TextInput
                                    type='number'
                                    placeholder='1080'
                                    value={draft.proxy.port}
                                    onChange={(e) => {
                                        setProxyTouched(true);
                                        set('proxy', { ...draft.proxy!, port: Number(e.target.value) || 1080 });
                                    }}
                                />
                            </div>
                        )}
                        {/* The DTO never echoes proxy credentials back, so there is
                            nothing to prefill — saying so beats silently dropping them. */}
                        {proxyPreconfigured && !proxyTouched && (
                            <span className={styles.fieldHint}>
                                Un proxy est déjà configuré sur ce compte. Il est conservé tel quel tant que vous ne
                                touchez pas à cette case ; le modifier impose de ressaisir ses paramètres.
                            </span>
                        )}
                    </>
                )}

                {testResult && <p className={styles.status}>{testResult}</p>}
            </div>

            <div className={styles.popupActions}>
                <div className={styles.popupActionsLeft}>
                    <DialogCancelButton>Fermer</DialogCancelButton>
                    {showManualFields && (
                        <Button variant='secondary' disabled={testing} onClick={() => void testConnection()}>
                            {testing ? 'Test…' : 'Tester la connexion'}
                        </Button>
                    )}
                    {mode === 'edit' && (
                        <Button variant='danger' onClick={() => close('delete')}>
                            Supprimer
                        </Button>
                    )}
                </div>
                {(showManualFields || providerManaged) && (
                    <Button onClick={() => void submit()}>{mode === 'add' ? 'Ajouter' : 'Enregistrer'}</Button>
                )}
            </div>
        </Popup>
    );
}

export default AccountPopup;
