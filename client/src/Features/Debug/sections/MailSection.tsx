import { useEffect, useMemo, useState } from 'react';
import type { CommandOutput, DebugMailPreview } from '@deveye/types';

import { ws, WsError } from '@/api/ws';
import Button from '@/Components/Button';
import SearchSelect from '@/Components/SearchSelect';
import SegmentedControl from '@/Components/SegmentedControl';
import TextInput from '@/Components/TextInput';
import styles from '../Debug.module.css';

type Catalog = CommandOutput<'debug.mailCatalog'>;

const RECIPIENT_KEY = 'deveye:debug-mail-to';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function rememberedRecipient(): string {
    try {
        return localStorage.getItem(RECIPIENT_KEY) ?? '';
    } catch {
        return '';
    }
}

function formatSize(bytes: number): string {
    return bytes < 1024 ? `${bytes} o` : `${Math.round(bytes / 1024)} Ko`;
}

/** Envoyer n'importe quel mail du serveur, rendu comme en vrai et par son vrai expéditeur, à une adresse choisie. */
export default function MailSection() {
    const [catalog, setCatalog] = useState<Catalog | null>(null);
    const [key, setKey] = useState('');
    const [to, setTo] = useState(rememberedRecipient);
    const [senderId, setSenderId] = useState('');
    const [preview, setPreview] = useState<DebugMailPreview | null>(null);
    const [view, setView] = useState<'html' | 'text'>('html');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);

    useEffect(() => {
        ws.send('debug.mailCatalog', {})
            .then((c) => {
                setCatalog(c);
                setKey((k) => k || c.samples[0]?.key || '');
                const first = c.senders[0];
                if (first) setSenderId(`${first.workspaceId}:${first.accountId}`);
            })
            .catch((e) => setError(e instanceof WsError ? e.message : 'Catalogue des mails illisible.'));
    }, []);

    useEffect(() => {
        if (!key) return;
        setPreview(null);
        ws.send('debug.mailPreview', { key })
            .then((p) => {
                setPreview(p);
                if (p.html === null) setView('text');
            })
            .catch((e) => setError(e instanceof WsError ? e.message : 'Aperçu impossible.'));
    }, [key]);

    const sample = catalog?.samples.find((s) => s.key === key) ?? null;
    const options = useMemo(
        () => (catalog?.samples ?? []).map((s) => ({ value: s.key, label: s.label, group: s.sourceLabel })),
        [catalog]
    );

    if (!catalog) return error ? <div className={styles.errorBanner}>{error}</div> : null;

    const validTo = EMAIL.test(to.trim());
    const [workspaceId, accountId] = senderId.split(':').map(Number);
    const senderReady =
        sample?.sender === 'server' ? catalog.server.configured : Number.isFinite(accountId) && accountId > 0;

    const send = async (): Promise<void> => {
        if (!sample) return;
        setBusy(true);
        setError(null);
        setNotice(null);
        try {
            localStorage.setItem(RECIPIENT_KEY, to.trim());
        } catch {
            // Le destinataire ne sera pas retenu : sans conséquence.
        }
        try {
            const result = await ws.send(
                'debug.mailSend',
                {
                    key: sample.key,
                    to: to.trim(),
                    sender:
                        sample.sender === 'server' ? { kind: 'server' } : { kind: 'workspace', workspaceId, accountId }
                },
                { timeoutMs: 30_000 }
            );
            setNotice(
                result.captured
                    ? `Retenu par le serveur : ${result.sentTo} est une adresse d’essai, rien n’est parti.`
                    : `Envoyé à ${result.sentTo}.`
            );
        } catch (e) {
            setError(e instanceof WsError ? e.message : 'Envoi impossible.');
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            <section className={styles.section}>
                <div className={styles.sectionHead}>
                    <span className={styles.sectionLabel}>Envoyer un mail</span>
                </div>
                <p className={styles.sectionHint}>
                    Le mail choisi est construit par la même fonction qu’en production, sur des données d’exemple, et
                    part de son vrai expéditeur. Au plus 10 envois toutes les 10 minutes.
                </p>
                {error && <div className={styles.errorBanner}>{error}</div>}
                {notice && <div className={styles.infoBanner}>{notice}</div>}
                <div className={`${styles.card} ${styles.formCard}`}>
                    <div className={styles.form}>
                        <div className={styles.formRow}>
                            <label className={styles.field}>
                                <span className={styles.fieldLabel}>Destinataire</span>
                                <TextInput
                                    type='email'
                                    value={to}
                                    placeholder='vous@exemple.fr'
                                    onChange={(e) => setTo(e.target.value)}
                                    autoComplete='email'
                                />
                            </label>
                            <div className={styles.field}>
                                <span className={styles.fieldLabel}>Mail</span>
                                <SearchSelect
                                    value={key}
                                    options={options}
                                    onChange={setKey}
                                    aria-label='Mail à envoyer'
                                    searchPlaceholder='Chercher un mail'
                                    emptyText='Aucun mail de ce nom'
                                />
                            </div>
                        </div>
                        <div className={styles.formRow}>
                            {sample?.sender === 'server' ? (
                                <div className={styles.field}>
                                    <span className={styles.fieldLabel}>Expéditeur</span>
                                    <span className={styles.rowMeta}>
                                        {catalog.server.configured
                                            ? `Le serveur : ${catalog.server.from ?? 'adresse de SMTP_FROM'}`
                                            : 'Aucun serveur SMTP configuré (SMTP_HOST) : ce mail ne peut pas partir.'}
                                    </span>
                                </div>
                            ) : (
                                <label className={styles.field}>
                                    <span className={styles.fieldLabel}>Expéditeur</span>
                                    {catalog.senders.length > 0 ? (
                                        <SearchSelect
                                            value={senderId}
                                            aria-label='Expéditeur'
                                            options={catalog.senders.map((s) => ({
                                                value: `${s.workspaceId}:${s.accountId}`,
                                                label: s.address,
                                                detail: s.workspaceName
                                            }))}
                                            onChange={setSenderId}
                                        />
                                    ) : (
                                        <span className={styles.rowMeta}>
                                            Ce mail part d’une boîte d’espace, et aucun de vos espaces n’en a une prête
                                            à envoyer.
                                        </span>
                                    )}
                                </label>
                            )}
                            <div className={`${styles.actions} ${styles.formEnd}`}>
                                <Button
                                    icon='mail'
                                    disabled={busy || !sample || !validTo || !senderReady}
                                    onClick={() => void send()}
                                >
                                    {busy ? 'Envoi…' : 'Envoyer'}
                                </Button>
                            </div>
                        </div>
                    </div>
                </div>
            </section>

            {preview && (
                <section className={styles.section}>
                    <div className={styles.sectionHead}>
                        <span className={styles.sectionLabel}>Aperçu</span>
                        {preview.html !== null && (
                            <SegmentedControl
                                value={view}
                                onChange={setView}
                                aria-label='Version affichée'
                                options={[
                                    { value: 'html', label: 'HTML' },
                                    { value: 'text', label: 'Texte' }
                                ]}
                            />
                        )}
                    </div>
                    <div className={styles.card}>
                        <div className={styles.row}>
                            <div className={styles.rowText}>
                                <span className={styles.rowMeta}>Sujet</span>
                                <span className={styles.rowTitle}>{preview.subject}</span>
                            </div>
                        </div>
                        {preview.attachments.length > 0 && (
                            <div className={styles.row}>
                                <span className={`icon icon-file ${styles.rowIcon}`} />
                                <div className={styles.rowText}>
                                    <span className={styles.rowMeta}>Pièces jointes</span>
                                    <span className={styles.rowTitle}>
                                        {preview.attachments
                                            .map((a) => `${a.filename} (${formatSize(a.size)})`)
                                            .join(', ')}
                                    </span>
                                </div>
                            </div>
                        )}
                        <div className={styles.row}>
                            {view === 'html' && preview.html !== null ? (
                                <iframe
                                    className={styles.preview}
                                    sandbox=''
                                    srcDoc={preview.html}
                                    title='Aperçu du mail'
                                />
                            ) : (
                                <pre className={styles.previewText}>{preview.text}</pre>
                            )}
                        </div>
                    </div>
                </section>
            )}
        </>
    );
}
