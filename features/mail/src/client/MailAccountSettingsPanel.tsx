import { useEffect, useRef, useState } from 'react';
import {
    Button,
    ReadOnlyNotice,
    SaveButton,
    Checkbox,
    ConfirmDialog,
    invalidate,
    SegmentedControl,
    settingsStyles as shell,
    TextInput,
    useResourceVersion,
    type ConfirmRequest
} from 'deveye-sdk-client';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';

import { api, humanizeError } from './api';
import { ProviderCard } from './ProviderCard';
import { awaitConsentWindow } from './oauthWindow';
import styles from './style.module.css';

import type { MailAccount, MailAccountDraft, MailAccountEdit, MailProxy } from '../contracts/domain';

/**
 * La boîte elle-même : son nom, ses serveurs, son proxy, et sa suppression.
 * L'onglet Général de ses réglages, là où le bouton commun mène.
 *
 * C'est le formulaire qui vivait dans une popup à part, ouverte par un bouton
 * « Modifier la boîte mail » : deux chemins pour régler une même chose, dont un
 * seul portait la moitié des réglages. La popup ne sert plus qu'à en AJOUTER
 * une, geste qui n'a pas d'élément à viser et donc pas d'onglet où vivre.
 *
 * Une boîte gérée par un fournisseur n'expose ni serveurs ni identifiants : ils
 * lui appartiennent, et `mail.accountUpdate` la refuse. Restent le nom et le
 * proxy, par `mail.accountSetProfile`.
 */
export default function MailAccountSettingsPanel({ scope, canWrite, close }: SettingsPanelProps) {
    const accountId = scope.kind === 'item' ? Number(scope.itemId) : null;
    const version = useResourceVersion('mail.accountList');
    const [account, setAccount] = useState<MailAccount | null>(null);
    const [draft, setDraft] = useState<MailAccountDraft | null>(null);
    const [proxyEnabled, setProxyEnabled] = useState(false);
    /** La boîte avait déjà un proxy à l'ouverture ; ses détails ne sont jamais renvoyés. */
    const [proxyPreconfigured, setProxyPreconfigured] = useState(false);
    /** Sans passage par les contrôles de proxy, on n'envoie rien à son sujet. */
    const [proxyTouched, setProxyTouched] = useState(false);
    const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
    const [busy, setBusy] = useState(false);
    const [testing, setTesting] = useState(false);
    const [status, setStatus] = useState<string | null>(null);
    const [errorName, setErrorName] = useState('');
    const [errorEmail, setErrorEmail] = useState('');
    const [reconnecting, setReconnecting] = useState(false);
    /** Les secrets ne sont jamais renvoyés : ils partent vides et le restent sauf saisie. */
    const blank = useRef(true);

    useEffect(() => {
        if (accountId === null) return;
        void api
            .send('mail.accountList', {})
            .then((res) => {
                const found = res.accounts.find((a) => a.id === accountId) ?? null;
                setAccount(found);
                if (!found) return;
                setDraft({
                    displayName: found.displayName,
                    emailAddress: found.emailAddress,
                    securityTier: found.securityTier,
                    imap: { host: found.imapHost, port: found.imapPort, username: '', password: '' },
                    smtp: { host: found.smtpHost, port: found.smtpPort, username: '', password: '' },
                    proxy: null
                });
                setProxyEnabled(found.proxyConfigured);
                setProxyPreconfigured(found.proxyConfigured);
                setProxyTouched(false);
                blank.current = true;
            })
            .catch((e) => setStatus(humanizeError(e, 'Chargement impossible.')));
    }, [accountId, version]);

    if (accountId === null) return null;
    if (!account || !draft) return <p className={shell.notice}>{status ?? 'Chargement…'}</p>;

    const providerManaged = account.authMethod !== 'password';
    /** Projetée depuis un autre espace : elle se règle chez elle, le serveur refuse d'ici. */
    const readOnly = !canWrite || account.foreign;

    function set<K extends keyof MailAccountDraft>(key: K, value: MailAccountDraft[K]): void {
        blank.current = false;
        setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
    }

    /** Le correctif de proxy : omis tant que personne n'y a touché. */
    function proxyPatch(): { proxy?: MailProxy | null } {
        if (!proxyTouched) return {};
        return { proxy: proxyEnabled ? (draft?.proxy ?? null) : null };
    }

    function validate(): boolean {
        if (!draft) return false;
        const name = draft.displayName.trim();
        setErrorName(name ? '' : 'Ce champ est obligatoire');
        if (providerManaged) {
            setErrorEmail('');
            return Boolean(name);
        }
        const email = draft.emailAddress.trim();
        const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
        setErrorEmail(validEmail ? '' : 'Adresse invalide');
        return Boolean(name) && validEmail;
    }

    async function save(): Promise<void> {
        if (!draft || !account || !validate()) return;
        setBusy(true);
        setStatus(null);
        try {
            if (providerManaged) {
                await api.send('mail.accountSetProfile', {
                    id: account.id,
                    displayName: draft.displayName.trim(),
                    securityTier: account.securityTier,
                    syncIntervalMinutes: account.syncIntervalMinutes,
                    ...proxyPatch()
                });
            } else {
                // Identifiants vides et proxy omis gardent ce qui est stocké :
                // renommer une boîte n'impose pas de retaper ses secrets.
                const { proxy: _current, ...rest } = draft;
                const edit: MailAccountEdit = {
                    ...rest,
                    displayName: draft.displayName.trim(),
                    emailAddress: draft.emailAddress.trim(),
                    ...proxyPatch()
                };
                await api.send('mail.accountUpdate', { id: account.id, draft: edit });
            }
            invalidate('mail.accountList');
            // Le bouton le dit ; ce canal reste aux erreurs et au test de connexion.
            setStatus(null);
        } catch (e) {
            setStatus(humanizeError(e, 'Enregistrement impossible.'));
            // Relancé : le bouton n'annonce « Enregistré » que sur un succès.
            throw e;
        } finally {
            setBusy(false);
        }
    }

    async function testConnection(): Promise<void> {
        if (!account || !validate()) return;
        setTesting(true);
        setStatus(null);
        try {
            // Le compte existant : le serveur reprend ses secrets stockés, que ce
            // formulaire n'a pas. Le brouillon ne sert qu'à un compte pas encore créé.
            const res = await api.send('mail.accountTestConnection', { id: account.id });
            if (res.imapOk && res.smtpOk) setStatus('Connexion IMAP et SMTP réussie.');
            else setStatus(res.error ?? 'Échec de la connexion.');
        } catch (e) {
            setStatus(humanizeError(e, 'Test impossible.'));
        } finally {
            setTesting(false);
        }
    }

    /**
     * Repasse par le consentement du fournisseur pour CETTE boîte : ses messages
     * et ses dossiers restent, seuls ses jetons sont remplacés. La suppression
     * suivie d'un nouvel ajout ferait le même travail au prix du cache entier.
     */
    async function reconnect(): Promise<void> {
        if (!account) return;
        setReconnecting(true);
        setStatus(null);
        try {
            const res = await api.send('mail.oauthStart', {
                provider: account.authMethod === 'oauth_google' ? 'google' : 'microsoft',
                securityTier: account.securityTier,
                displayName: '',
                accountId: account.id
            });
            const popup = window.open(res.authUrl, 'deveye-mail-oauth', 'width=520,height=680');
            if (!popup) throw new Error('Fenêtre bloquée par le navigateur — autorisez les popups pour DevEye.');
            const { verdict } = await awaitConsentWindow(popup);
            if (verdict && !verdict.ok) throw new Error(verdict.error ?? 'Échec de connexion.');
            invalidate('mail.accountList');
            setStatus(verdict?.ok ? 'Boîte reconnectée.' : 'Fenêtre fermée : vérifiez l’état de la boîte.');
        } catch (e) {
            setStatus(humanizeError(e, 'Reconnexion impossible.'));
        } finally {
            setReconnecting(false);
        }
    }

    function requestDelete(): void {
        if (!account) return;
        setConfirm({
            title: `Supprimer « ${account.displayName} » ?`,
            description:
                'La boîte et tous les messages relevés sont effacés de DevEye. Rien n’est touché sur le serveur de messagerie.',
            confirmLabel: 'Supprimer',
            onConfirm: () => {
                setConfirm(null);
                setBusy(true);
                void api
                    .send('mail.accountDelete', { id: account.id })
                    .then(() => {
                        invalidate('mail.accountCount', 'mail.accountList');
                        // La boîte qu'on réglait n'existe plus : rester
                        // afficherait les réglages de la fonctionnalité sous son
                        // nom, le temps que la vue se ravise.
                        close();
                    })
                    .catch((e) => setStatus(humanizeError(e, 'Suppression impossible.')))
                    .finally(() => setBusy(false));
            }
        });
    }

    return (
        <div className={shell.section}>
            <div className={shell.field}>
                <span className={shell.sectionLabel}>Identité</span>
                <TextInput
                    placeholder='Nom (ex. Perso Gmail)'
                    value={draft.displayName}
                    error={errorName}
                    disabled={readOnly}
                    onChange={(e) => set('displayName', e.target.value)}
                />
                {providerManaged ? (
                    <ProviderCard
                        account={account}
                        busy={reconnecting}
                        onReconnect={readOnly ? undefined : () => void reconnect()}
                    />
                ) : (
                    <TextInput
                        type='email'
                        placeholder='adresse@exemple.com'
                        value={draft.emailAddress}
                        error={errorEmail}
                        disabled={readOnly}
                        onChange={(e) => set('emailAddress', e.target.value)}
                    />
                )}
            </div>

            {!providerManaged && (
                <>
                    <div className={shell.field}>
                        <span className={shell.sectionLabel}>IMAP (réception)</span>
                        <div className={styles.formRow}>
                            <TextInput
                                placeholder='imap.exemple.com'
                                value={draft.imap.host}
                                disabled={readOnly}
                                onChange={(e) => set('imap', { ...draft.imap, host: e.target.value })}
                            />
                            <TextInput
                                type='number'
                                placeholder='993'
                                value={draft.imap.port}
                                disabled={readOnly}
                                onChange={(e) => set('imap', { ...draft.imap, port: Number(e.target.value) || 993 })}
                            />
                        </div>
                        <div className={styles.formRow}>
                            <TextInput
                                placeholder='Identifiant'
                                value={draft.imap.username}
                                disabled={readOnly}
                                onChange={(e) => set('imap', { ...draft.imap, username: e.target.value })}
                            />
                            <TextInput
                                type='password'
                                placeholder='Nouveau mot de passe'
                                value={draft.imap.password}
                                disabled={readOnly}
                                onChange={(e) => set('imap', { ...draft.imap, password: e.target.value })}
                            />
                        </div>
                    </div>

                    <div className={shell.field}>
                        <span className={shell.sectionLabel}>SMTP (envoi)</span>
                        <div className={styles.formRow}>
                            <TextInput
                                placeholder='smtp.exemple.com'
                                value={draft.smtp.host}
                                disabled={readOnly}
                                onChange={(e) => set('smtp', { ...draft.smtp, host: e.target.value })}
                            />
                            <TextInput
                                type='number'
                                placeholder='465'
                                value={draft.smtp.port}
                                disabled={readOnly}
                                onChange={(e) => set('smtp', { ...draft.smtp, port: Number(e.target.value) || 465 })}
                            />
                        </div>
                        <div className={styles.formRow}>
                            <TextInput
                                placeholder='Identifiant'
                                value={draft.smtp.username}
                                disabled={readOnly}
                                onChange={(e) => set('smtp', { ...draft.smtp, username: e.target.value })}
                            />
                            <TextInput
                                type='password'
                                placeholder='Nouveau mot de passe'
                                value={draft.smtp.password}
                                disabled={readOnly}
                                onChange={(e) => set('smtp', { ...draft.smtp, password: e.target.value })}
                            />
                        </div>
                        <span className={shell.fieldHint}>
                            Les mots de passe ne sont jamais réaffichés. Laissés vides, ceux qui sont enregistrés
                            restent en place.
                        </span>
                    </div>
                </>
            )}

            <div className={shell.field}>
                <span className={shell.sectionLabel}>Proxy</span>
                <Checkbox
                    checked={proxyEnabled}
                    disabled={readOnly}
                    onChange={(checked) => {
                        setProxyEnabled(checked);
                        setProxyTouched(true);
                        if (checked && !draft.proxy) {
                            set('proxy', { kind: 'socks5', host: '', port: 1080, username: null, password: null });
                        }
                    }}
                >
                    Passer par un proxy (SOCKS5/HTTP), que vous fournissez vous-même
                </Checkbox>
                {proxyEnabled && draft.proxy && (
                    <div className={styles.formRow}>
                        <SegmentedControl
                            aria-label='Type de proxy'
                            value={draft.proxy.kind}
                            disabled={readOnly}
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
                            disabled={readOnly}
                            onChange={(e) => {
                                setProxyTouched(true);
                                set('proxy', { ...draft.proxy!, host: e.target.value });
                            }}
                        />
                        <TextInput
                            type='number'
                            placeholder='1080'
                            value={draft.proxy.port}
                            disabled={readOnly}
                            onChange={(e) => {
                                setProxyTouched(true);
                                set('proxy', { ...draft.proxy!, port: Number(e.target.value) || 1080 });
                            }}
                        />
                    </div>
                )}
                {proxyPreconfigured && !proxyTouched && (
                    <span className={shell.fieldHint}>
                        Un proxy est déjà configuré sur cette boîte. Il est conservé tel quel tant que vous ne touchez
                        pas à cette case ; le modifier impose de ressaisir ses paramètres.
                    </span>
                )}
            </div>

            {!readOnly && (
                <div className={shell.sectionActions}>
                    <SaveButton onSave={save} disabled={busy} />
                    {!providerManaged && (
                        <Button variant='secondary' disabled={testing || busy} onClick={() => void testConnection()}>
                            {testing ? 'Test…' : 'Tester la connexion'}
                        </Button>
                    )}
                </div>
            )}

            {account.foreign && (
                <p className={shell.sectionHint}>
                    Cette boîte appartient à un autre espace qui la partage ici : elle se règle et se supprime chez
                    elle.
                </p>
            )}
            {!canWrite && (
                <ReadOnlyNotice>
                    Votre rôle ne permet pas de modifier une boîte : cela relève de l’écriture sur Mail.
                </ReadOnlyNotice>
            )}

            {status && <p className={shell.notice}>{status}</p>}

            {!readOnly && (
                <div className={shell.field}>
                    <span className={shell.sectionLabel}>Supprimer cette boîte</span>
                    <span className={shell.fieldHint}>
                        La boîte et tous ses messages relevés sont effacés de DevEye. Rien n’est touché sur le serveur
                        de messagerie.
                    </span>
                    <div className={shell.sectionActions}>
                        <Button variant='danger' disabled={busy} onClick={requestDelete}>
                            Supprimer la boîte mail
                        </Button>
                    </div>
                </div>
            )}

            <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} busy={busy} />
        </div>
    );
}
