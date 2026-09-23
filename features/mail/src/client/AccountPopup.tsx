import { useRef, useState } from 'react';
import {
    Button,
    Checkbox,
    ClosePopup,
    DialogCancelButton,
    Popup,
    SegmentedControl,
    Term,
    TextInput,
    useActiveWorkspace
} from 'deveye-sdk-client';

import { api, humanizeError } from './api';
import { awaitConsentWindow } from './oauthWindow';
import { ProviderCard } from './ProviderCard';
import { SecurityTierChoice } from './SecurityTierChoice';
import { StepBody, StepFrame, StepHeader } from './AccountSteps';
import styles from './style.module.css';

import { MAIL_SYNC_INTERVAL_DEFAULT_MINUTES } from '../contracts/domain';
import type { MailAccountPrefill } from '@deveye/types/sdk/client';
import type {
    MailAccount,
    MailAccountDraft,
    MailAccountEdit,
    MailAuthMethod,
    MailOAuthProvider,
    MailProxy
} from '../contracts/domain';

export const ACCOUNT_POPUP = 'popup-mail-account';

/**
 * Les fournisseurs offerts, dans l'ordre d'affichage. `oauth: null` : pas encore
 * de connexion côté serveur, le bouton s'annonce sans s'offrir.
 */
const PROVIDERS: readonly { label: string; icon: string; oauth: MailOAuthProvider | null }[] = [
    { label: 'Google', icon: 'google', oauth: 'google' },
    { label: 'Microsoft', icon: 'microsoft', oauth: 'microsoft' },
    { label: 'Apple', icon: 'apple', oauth: null }
];

export type AccountPopupResult = 'delete' | 'saved' | 'oauth-connected' | null;

/** What the popup opens on: an account to edit, a mailbox another feature already knows, or nothing. */
export type AccountPopupInput = MailAccount | { prefill: MailAccountPrefill } | null;

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
    const [step, setStep] = useState<1 | 2>(1);
    /** Les fournisseurs que ce serveur sait connecter ; `null` tant qu'il n'a pas répondu. */
    const [configured, setConfigured] = useState<readonly MailOAuthProvider[] | null>(null);
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
    /** La boîte telle que le serveur la rend, une fois le consentement abouti. */
    const [adopted, setAdopted] = useState<MailAccount | null>(null);
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
        setAdopted(account);
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

    function handleOpen(opened: AccountPopupInput): void {
        const prefill = opened !== null && 'prefill' in opened ? opened.prefill : null;
        const input = opened !== null && 'prefill' in opened ? null : opened;
        setStep(1);
        setConfigured(null);
        if (opened === null || 'prefill' in opened) {
            void api
                .send('mail.oauthProviders', {})
                .then((res) => setConfigured(res.configured))
                .catch(() => setConfigured([]));
        }
        setTestResult(null);
        setErrorName('');
        setErrorEmail('');
        setConnected(false);
        setAdopted(input);
        setAccountId(input?.id ?? null);
        setMode(input ? 'edit' : 'add');
        setAuthMethod(input?.authMethod ?? 'password');
        setSyncIntervalMinutes(input?.syncIntervalMinutes ?? MAIL_SYNC_INTERVAL_DEFAULT_MINUTES);
        // Land straight on the tab that has something to show: the manual form
        // for a password account, the provider notice for an OAuth one.
        setTab(prefill || (input && input.authMethod === 'password') ? 'manual' : 'providers');
        const next: MailAccountDraft = input ? draftFromAccount(input) : DEFAULT_DRAFT;
        // A prefilled form counts as unsaved from the start: it is ready to save as is.
        setDraft(prefill ? { ...DEFAULT_DRAFT, ...prefill } : next);
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
        // Le palier « fournisseur » n'a pas de champ adresse : celle d'un compte
        // géré vient du fournisseur, et l'onglet Fournisseurs n'en demande aucune.
        if (!showManualFields) {
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
     * Le compte que le consentement vient de créer. La liste peut ne pas encore
     * le porter au premier appel : la fenêtre se ferme dès que le serveur a
     * répondu, et l'écriture n'est pas forcément visible dans la foulée. On
     * redemande quelques fois plutôt que de conclure à l'échec.
     */
    async function findNewAccount(before: Set<number>): Promise<MailAccount | undefined> {
        for (let attempt = 0; attempt < 4; attempt++) {
            const found = (await api.send('mail.accountList', {})).accounts.find((a) => !before.has(a.id));
            if (found) return found;
            await new Promise((r) => setTimeout(r, 300));
        }
        return undefined;
    }

    async function connectOAuth(provider: MailOAuthProvider): Promise<void> {
        setOauthBusy(provider);
        setTestResult(null);
        try {
            const before = new Set((await api.send('mail.accountList', {})).accounts.map((a) => a.id));
            const res = await api.send('mail.oauthStart', {
                provider,
                securityTier: draft.securityTier,
                displayName: draft.displayName.trim()
            });
            const popup = window.open(res.authUrl, 'deveye-mail-oauth', 'width=520,height=680');
            if (!popup) throw new Error('Fenêtre bloquée par le navigateur — autorisez les popups pour DevEye.');

            const { verdict } = await awaitConsentWindow(popup);
            // Un échec annoncé par le serveur s'affiche tel quel : lui seul sait
            // ce qui a manqué, et le paraphraser perdrait la seule information utile.
            if (verdict && !verdict.ok) throw new Error(verdict.error ?? 'Échec de connexion.');

            const created = await findNewAccount(before);
            if (created) {
                adopt(created);
                setConnected(true);
                return;
            }
            // Le serveur a dit que c'était fait : la boîte existe, seule la liste
            // tarde. Annoncer un échec ici enverrait rouvrir un compte qui vient
            // d'être créé.
            if (verdict?.ok) {
                setConnected(true);
                // Plus rien à sauver : sans cela, fermer demanderait de confirmer
                // l'abandon d'un formulaire dont le travail est déjà fait.
                initial.current = draft;
                setTestResult('Boîte connectée. Fermez cette fenêtre pour la voir apparaître.');
                return;
            }
            throw new Error('La fenêtre de connexion s’est fermée avant la fin.');
        } catch (e) {
            setTestResult(e instanceof Error ? e.message : 'Échec de connexion.');
        } finally {
            setOauthBusy(null);
        }
    }

    // Le choix de protection n'existe qu'à la création, et seulement dans l'espace
    // personnel : un espace partagé n'a qu'une clé, lisible par tout membre.
    const twoSteps = mode === 'add' && workspace?.kind === 'personal';
    const onFirstStep = twoSteps && step === 1;

    return (
        <Popup
            id={ACCOUNT_POPUP}
            title={mode === 'add' ? 'Ajouter une boîte mail' : 'Modifier la boîte mail'}
            width={560}
            onInputChange={handleOpen}
            onClosePopup={() => close()}
            onSubmit={() => (onFirstStep ? setStep(2) : void submit())}
            dirty={dirty}
            onSave={() => void submit()}
        >
            <div className={twoSteps ? styles.steps : undefined}>
                {twoSteps && (
                    <section className={styles.step}>
                        <StepHeader
                            number={1}
                            title='Protection'
                            summary={draft.securityTier === 'guarded' ? 'Protégée' : 'Ouverte'}
                            open={step === 1}
                            controls='mail-account-step-1'
                            onClick={() => setStep(1)}
                        />
                        <StepBody id='mail-account-step-1' open={step === 1}>
                            <SecurityTierChoice
                                advise
                                value={draft.securityTier}
                                onChange={(tier) => set('securityTier', tier)}
                                onPick={() => setStep(2)}
                            />
                        </StepBody>
                    </section>
                )}
                <StepFrame
                    framed={twoSteps}
                    header={
                        <StepHeader
                            number={2}
                            title='Connexion'
                            open={step === 2}
                            controls='mail-account-step-2'
                            onClick={() => setStep(2)}
                        />
                    }
                    id='mail-account-step-2'
                    open={step === 2}
                >
                    <p className={styles.sectionLabel}>Nom</p>
                    <TextInput
                        placeholder='ex. Perso Gmail'
                        aria-label='Nom de la boîte'
                        value={draft.displayName}
                        error={errorName}
                        onChange={(e) => set('displayName', e.target.value)}
                    />

                    {/* An OAuth account has no second tab to offer: the manual form can't
                    describe it and can't save it either. */}
                    {!providerManaged && (
                        <>
                            <p className={styles.sectionLabel}>Méthode de connexion</p>
                            <SegmentedControl
                                aria-label='Méthode de connexion'
                                fullWidth
                                value={tab}
                                options={[
                                    { value: 'providers', label: 'Fournisseurs' },
                                    { value: 'manual', label: 'Connexion manuelle' }
                                ]}
                                onChange={setTab}
                            />
                        </>
                    )}

                    {/* La boîte que le consentement vient de créer : son état sort de
                    la liste, seule à le connaître. La reconnexion n'est pas
                    proposée ici, elle est dans les réglages de la boîte. */}
                    {providerManaged && adopted && <ProviderCard account={adopted} />}

                    {!providerManaged && tab === 'providers' && (
                        <div className={styles.oauthButtons}>
                            {mode === 'add' ? (
                                <>
                                    {PROVIDERS.map((p) => {
                                        const available = p.oauth !== null && configured?.includes(p.oauth) === true;
                                        return (
                                            <Button
                                                key={p.label}
                                                variant='secondary'
                                                icon={p.icon}
                                                disabled={!available || oauthBusy !== null}
                                                onClick={() => p.oauth && void connectOAuth(p.oauth)}
                                            >
                                                {oauthBusy !== null && oauthBusy === p.oauth
                                                    ? 'Connexion…'
                                                    : `Se connecter avec ${p.label}`}
                                                {configured !== null && !available && (
                                                    <span className={styles.soonTag}>Bientôt</span>
                                                )}
                                            </Button>
                                        );
                                    })}
                                    {configured !== null && configured.length < PROVIDERS.length && (
                                        <span className={styles.fieldHint}>
                                            Les fournisseurs grisés ne sont pas encore disponibles : ils le seront
                                            bientôt. En attendant, la connexion manuelle fonctionne avec toutes les
                                            boîtes.
                                        </span>
                                    )}
                                </>
                            ) : (
                                <span className={styles.fieldHint}>
                                    Ce compte utilise une connexion manuelle : on ne peut pas le convertir en compte
                                    Google/Microsoft après coup. Ajoutez plutôt une nouvelle boîte mail depuis cet
                                    onglet si vous voulez vous connecter avec un fournisseur.
                                </span>
                            )}
                        </div>
                    )}

                    {showManualFields && (
                        <>
                            <p className={styles.sectionLabel}>Adresse e-mail</p>
                            <TextInput
                                type='email'
                                placeholder='adresse@exemple.com'
                                aria-label='Adresse e-mail'
                                value={draft.emailAddress}
                                error={errorEmail}
                                onChange={(e) => set('emailAddress', e.target.value)}
                            />

                            <p className={styles.sectionLabel}>
                                <Term id='imap'>IMAP</Term> (réception)
                            </p>
                            <div className={`${styles.fillRow} ${styles.hostRow}`}>
                                <TextInput
                                    placeholder='imap.exemple.com'
                                    value={draft.imap.host}
                                    onChange={(e) => set('imap', { ...draft.imap, host: e.target.value })}
                                />
                                <TextInput
                                    type='number'
                                    placeholder='993'
                                    value={draft.imap.port}
                                    onChange={(e) =>
                                        set('imap', { ...draft.imap, port: Number(e.target.value) || 993 })
                                    }
                                />
                            </div>
                            <div className={styles.fillRow}>
                                <TextInput
                                    placeholder='Identifiant'
                                    value={draft.imap.username}
                                    onChange={(e) => set('imap', { ...draft.imap, username: e.target.value })}
                                />
                                <TextInput
                                    type='password'
                                    enableShowHideButton
                                    placeholder={mode === 'edit' ? 'Nouveau mot de passe' : 'Mot de passe'}
                                    value={draft.imap.password}
                                    onChange={(e) => set('imap', { ...draft.imap, password: e.target.value })}
                                />
                            </div>

                            <p className={styles.sectionLabel}>
                                <Term id='smtp'>SMTP</Term> (envoi)
                            </p>
                            <div className={`${styles.fillRow} ${styles.hostRow}`}>
                                <TextInput
                                    placeholder='smtp.exemple.com'
                                    value={draft.smtp.host}
                                    onChange={(e) => set('smtp', { ...draft.smtp, host: e.target.value })}
                                />
                                <TextInput
                                    type='number'
                                    placeholder='465'
                                    value={draft.smtp.port}
                                    onChange={(e) =>
                                        set('smtp', { ...draft.smtp, port: Number(e.target.value) || 465 })
                                    }
                                />
                            </div>
                            <div className={styles.fillRow}>
                                <TextInput
                                    placeholder='Identifiant'
                                    value={draft.smtp.username}
                                    onChange={(e) => set('smtp', { ...draft.smtp, username: e.target.value })}
                                />
                                <TextInput
                                    type='password'
                                    enableShowHideButton
                                    placeholder={mode === 'edit' ? 'Nouveau mot de passe' : 'Mot de passe'}
                                    value={draft.smtp.password}
                                    onChange={(e) => set('smtp', { ...draft.smtp, password: e.target.value })}
                                />
                            </div>
                        </>
                    )}

                    {showProxyFields && (
                        <>
                            <p className={styles.sectionLabel}>
                                <Term id='proxy'>Proxy</Term>
                            </p>
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
                                Passer par un proxy (SOCKS5/HTTP), que vous fournissez vous-même
                            </Checkbox>
                            {proxyEnabled && draft.proxy && (
                                <div className={`${styles.fillRow} ${styles.hostRow}`}>
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
                </StepFrame>
            </div>

            <div className={styles.popupActions}>
                <div className={styles.popupActionsLeft}>
                    {twoSteps && step === 2 ? (
                        <Button variant='secondary' onClick={() => setStep(1)}>
                            Précédent
                        </Button>
                    ) : (
                        <DialogCancelButton>Fermer</DialogCancelButton>
                    )}
                    {showManualFields && !onFirstStep && (
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
                {onFirstStep ? (
                    <Button onClick={() => setStep(2)}>Continuer</Button>
                ) : (
                    (showManualFields || providerManaged) && (
                        <Button onClick={() => void submit()}>{mode === 'add' ? 'Ajouter' : 'Enregistrer'}</Button>
                    )
                )}
            </div>
        </Popup>
    );
}

export default AccountPopup;
