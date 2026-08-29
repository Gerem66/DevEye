import { useRef, useState } from 'react';
import {
    Button,
    Checkbox,
    ClosePopup,
    DialogCancelButton,
    Popup,
    SegmentedControl,
    TextInput,
    useActiveWorkspace
} from 'deveye-sdk-client';

import { api, humanizeError } from './api';
import { SECURITY_TIER_HINT, SECURITY_TIER_OPTIONS } from './securityTier';
import styles from './style.module.css';

import { MAIL_SYNC_INTERVAL_DEFAULT_MINUTES } from '../contracts/domain';
import type {
    MailAccount,
    MailAccountDraft,
    MailAccountEdit,
    MailAuthMethod,
    MailOAuthProvider,
    MailProxy
} from '../contracts/domain';

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
 * created entirely server-side via the popup-window consent flow: this form only
 * drives password-auth accounts, plus the "Connect with..." buttons that kick
 * off OAuth for a brand new account.
 *
 * Opening an OAuth account here is read-only: its settings live with the
 * provider and `mail.accountUpdate` rejects it outright, so the form is locked
 * and only the delete action stays live. It still has to open, the delete button
 * living nowhere else.
 */
export function AccountPopup() {
    const [mode, setMode] = useState<'add' | 'edit'>('add');
    const [tab, setTab] = useState<'providers' | 'manual'>('providers');
    const [authMethod, setAuthMethod] = useState<MailAuthMethod>('password');
    /** Owned by the account's options panel, not by this form — resubmitted unchanged. */
    const [syncIntervalMinutes, setSyncIntervalMinutes] = useState(MAIL_SYNC_INTERVAL_DEFAULT_MINUTES);
    const [accountId, setAccountId] = useState<number | null>(null);
    const [draft, setDraft] = useState<MailAccountDraft>(DEFAULT_DRAFT);
    const workspace = useActiveWorkspace();
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
    /**
     * A mailbox was connected during *this* opening of the form. The account
     * already exists server-side at that point, so even a plain "Fermer" has to
     * tell the caller to reload.
     */
    const [connected, setConnected] = useState(false);
    const initial = useRef<MailAccountDraft>(DEFAULT_DRAFT);
    /**
     * An OAuth mailbox: its servers and secrets belong to the provider, so the
     * manual form is out, but the label, the storage tier and the proxy stay
     * editable through `mail.accountSetProfile`.
     */
    const providerManaged = mode === 'edit' && authMethod !== 'password';
    const showManualFields = !providerManaged && tab === 'manual';
    const showProxyFields = showManualFields || providerManaged;

    function set<K extends keyof MailAccountDraft>(key: K, value: MailAccountDraft[K]): void {
        setDraft((prev) => ({ ...prev, [key]: value }));
    }

    /** An account as this form's draft. Secrets are never echoed back, so they start blank. */
    function draftFromAccount(account: MailAccount): MailAccountDraft {
        return {
            displayName: account.displayName,
            emailAddress: account.emailAddress,
            securityTier: account.securityTier,
            imap: { host: account.imapHost, port: account.imapPort, username: '', password: '' },
            smtp: { host: account.smtpHost, port: account.smtpPort, username: '', password: '' },
            proxy: null
        };
    }

    /** Point the form at an existing account, with nothing counted as unsaved yet. */
    function adopt(account: MailAccount): void {
        setAccountId(account.id);
        setMode('edit');
        setAuthMethod(account.authMethod);
        setSyncIntervalMinutes(account.syncIntervalMinutes);
        const next = draftFromAccount(account);
        setDraft(next);
        initial.current = next;
        setProxyEnabled(account.proxyConfigured);
        setProxyPreconfigured(account.proxyConfigured);
        setProxyTouched(false);
    }

    function handleOpen(input: MailAccount | null): void {
        setTestResult(null);
        setErrorName('');
        setErrorEmail('');
        setConnected(false);
        setAccountId(input?.id ?? null);
        setMode(input ? 'edit' : 'add');
        setAuthMethod(input?.authMethod ?? 'password');
        setSyncIntervalMinutes(input?.syncIntervalMinutes ?? MAIL_SYNC_INTERVAL_DEFAULT_MINUTES);
        // Land straight on the tab that has something to show: the manual form
        // for a password account, the provider notice for an OAuth one.
        setTab(input && input.authMethod === 'password' ? 'manual' : 'providers');
        const next: MailAccountDraft = input ? draftFromAccount(input) : DEFAULT_DRAFT;
        setDraft(next);
        setProxyEnabled(input?.proxyConfigured ?? false);
        setProxyPreconfigured(input?.proxyConfigured ?? false);
        setProxyTouched(false);
        initial.current = next;
    }

    const dirty = JSON.stringify(draft) !== JSON.stringify(initial.current);

    function close(result: AccountPopupResult = connected ? 'oauth-connected' : null): void {
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
            const res = await api.send('mail.accountTestConnection', accountId ? { id: accountId } : { draft });
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
                await api.send('mail.accountSetProfile', {
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
                await api.send('mail.accountUpdate', { id: accountId, draft: edit });
            } else {
                const payload: MailAccountDraft = {
                    ...draft,
                    displayName: draft.displayName.trim(),
                    emailAddress: draft.emailAddress.trim(),
                    proxy: proxyEnabled ? draft.proxy : null
                };
                await api.send('mail.accountAdd', { draft: payload });
            }
            close('saved');
        } catch (e) {
            setTestResult(humanizeError(e, 'Enregistrement impossible.'));
        }
    }

    /**
     * Waits for the consent window to finish, by message or by closing. Never
     * rejects on close, and never trusts the message as the verdict: the callback
     * page is served from the app origin, which is not necessarily the one the SPA
     * was loaded from (in dev, the API port against Vite's), and `postMessage` to
     * a mismatched target origin is dropped without a word. The message is only a
     * way to stop waiting early; the account list decides.
     */
    function awaitConsentWindow(popup: Window): Promise<{ error: string | null }> {
        return new Promise((resolve) => {
            const finish = (result: { error: string | null }) => {
                window.removeEventListener('message', onMessage);
                clearInterval(poll);
                resolve(result);
            };
            function onMessage(e: MessageEvent) {
                const data = e.data as { source?: string; ok?: boolean; error?: string } | undefined;
                if (data?.source !== 'deveye-mail-oauth') return;
                finish({ error: data.ok ? null : (data.error ?? 'Échec de connexion') });
            }
            const poll = window.setInterval(() => {
                if (popup.closed) finish({ error: null });
            }, 500);
            window.addEventListener('message', onMessage);
        });
    }

    async function connectOAuth(provider: MailOAuthProvider): Promise<void> {
        setOauthBusy(provider);
        setTestResult(null);
        try {
            const before = new Set((await api.send('mail.accountList', {})).accounts.map((a) => a.id));
            const res = await api.send('mail.oauthStart', { provider, securityTier: draft.securityTier });
            const popup = window.open(res.authUrl, 'deveye-mail-oauth', 'width=520,height=680');
            if (!popup) throw new Error('Fenêtre bloquée par le navigateur — autorisez les popups pour DevEye.');

            const { error } = await awaitConsentWindow(popup);
            // The server is the only thing that knows whether the account got
            // created, so ask it rather than inferring from the window.
            const created = (await api.send('mail.accountList', {})).accounts.find((a) => !before.has(a.id));
            if (!created) throw new Error(error ?? 'La connexion n’a pas abouti.');

            adopt(created);
            setConnected(true);
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
                {/* A provider-managed mailbox has its address shown on the card
                    below, where it belongs. */}
                {!providerManaged && (
                    <TextInput
                        type='email'
                        placeholder='adresse@exemple.com'
                        value={draft.emailAddress}
                        error={errorEmail}
                        onChange={(e) => set('emailAddress', e.target.value)}
                    />
                )}

                {/* Le palier ne se choisit qu'à la création : il détermine sous
                    quelle clé la boîte naît, et se change ensuite dans l'onglet
                    Chiffrement de ses réglages. Seulement dans l'espace personnel :
                    un espace partagé n'a qu'une clé, lisible par tout membre, donc
                    un seul palier. */}
                {mode === 'add' && workspace?.kind === 'personal' && (
                    <div className={styles.tierChoice}>
                        <SegmentedControl
                            aria-label='Palier de chiffrement'
                            value={draft.securityTier}
                            options={SECURITY_TIER_OPTIONS}
                            onChange={(tier) => set('securityTier', tier)}
                        />
                        <span className={styles.fieldHint}>{SECURITY_TIER_HINT[draft.securityTier]}</span>
                    </div>
                )}

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

                {providerManaged && (
                    <div className={styles.providerCard}>
                        <span className={`icon icon-check-circle ${styles.providerCardCheck}`} aria-hidden='true' />
                        <span className={styles.providerCardBody}>
                            <strong className={styles.providerCardTitle}>
                                Connecté via {authMethod === 'oauth_google' ? 'Google' : 'Microsoft'}
                            </strong>
                            <span className={styles.providerCardAddress}>{draft.emailAddress}</span>
                            <span className={styles.fieldHint}>
                                Les identifiants et les serveurs sont gérés par le fournisseur — il n’y a rien à
                                configurer ici. Pour repartir de zéro, supprimez cette boîte puis reconnectez-la.
                            </span>
                        </span>
                    </div>
                )}

                {!providerManaged && tab === 'providers' && (
                    <div className={styles.oauthButtons}>
                        {mode === 'add' ? (
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
                        <Checkbox
                            checked={proxyEnabled}
                            onChange={(checked) => {
                                setProxyEnabled(checked);
                                setProxyTouched(true);
                                if (checked && !draft.proxy) {
                                    set('proxy', {
                                        kind: 'socks5',
                                        host: '',
                                        port: 1080,
                                        username: null,
                                        password: null
                                    });
                                }
                            }}
                        >
                            Passer par un proxy (SOCKS5/HTTP) — déjà géré par vous, DevEye n’en fournit pas
                        </Checkbox>
                        {proxyEnabled && draft.proxy && (
                            <div className={styles.formRow}>
                                <SegmentedControl
                                    aria-label='Type de proxy'
                                    value={draft.proxy.kind}
                                    options={[
                                        { value: 'socks5', label: 'SOCKS5' },
                                        { value: 'http', label: 'HTTP' }
                                    ]}
                                    onChange={(kind) => {
                                        setProxyTouched(true);
                                        set('proxy', { ...draft.proxy!, kind });
                                    }}
                                />
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
                            nothing to prefill; saying so beats silently dropping them. */}
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
