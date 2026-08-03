import { useRef, useState } from 'react';

import Button from '@/Components/Button';
import { DialogCancelButton } from '@/Components/Dialog';
import Popup, { ClosePopup } from '@/Components/Popup';
import SelectInput from '@/Components/SelectInput';
import TextInput from '@/Components/TextInput';
import { formatSize, humanizeError, ws } from './api';
import styles from './style.module.css';

import type { MailAccount, MailAddress } from 'deveye-types';

export const COMPOSE_POPUP = 'popup-mail-compose';

export interface ComposeInput {
    accounts: MailAccount[];
    defaultAccountId: number | null;
}

interface DraftAttachment {
    filename: string;
    mimeType: string;
    contentBase64: string;
    size: number;
}

function parseAddresses(raw: string): MailAddress[] {
    return raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((address) => ({ name: null, address }));
}

/** Strips the `data:mime;base64,` prefix FileReader adds, keeping only the payload `mail.send` expects. */
function readAsBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
        reader.onerror = () => reject(reader.error ?? new Error('Lecture du fichier impossible'));
        reader.readAsDataURL(file);
    });
}

/**
 * Plain-text compose (a rich HTML editor is a V2 nicety, not V1 scope). Cc/Cci
 * and attachments — both already supported by `mail.send` — sit behind an
 * "advanced fields" toggle so the default view stays to the essentials: from,
 * to, subject, body.
 */
export function ComposePopup() {
    const [accounts, setAccounts] = useState<MailAccount[]>([]);
    const [accountId, setAccountId] = useState<number | null>(null);
    const [to, setTo] = useState('');
    const [cc, setCc] = useState('');
    const [bcc, setBcc] = useState('');
    const [subject, setSubject] = useState('');
    const [body, setBody] = useState('');
    const [attachments, setAttachments] = useState<DraftAttachment[]>([]);
    const [advancedOpen, setAdvancedOpen] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [sending, setSending] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    function handleOpen(input: ComposeInput | null): void {
        if (!input) return;
        setAccounts(input.accounts);
        setAccountId(input.defaultAccountId ?? input.accounts[0]?.id ?? null);
        setTo('');
        setCc('');
        setBcc('');
        setSubject('');
        setBody('');
        setAttachments([]);
        setAdvancedOpen(false);
        setError(null);
    }

    function close(sent: boolean): void {
        ClosePopup(COMPOSE_POPUP, sent);
    }

    async function addFiles(files: FileList | null): Promise<void> {
        if (!files || files.length === 0) return;
        const next = await Promise.all(
            Array.from(files).map(async (file) => ({
                filename: file.name,
                mimeType: file.type || 'application/octet-stream',
                contentBase64: await readAsBase64(file),
                size: file.size
            }))
        );
        setAttachments((prev) => [...prev, ...next]);
    }

    function removeAttachment(index: number): void {
        setAttachments((prev) => prev.filter((_, i) => i !== index));
    }

    async function send(): Promise<void> {
        const recipients = parseAddresses(to);
        if (!accountId || recipients.length === 0 || !subject.trim()) {
            setError('Compte, destinataire et objet sont obligatoires.');
            return;
        }
        setSending(true);
        setError(null);
        try {
            await ws.send('mail.send', {
                accountId,
                to: recipients,
                cc: cc.trim() ? parseAddresses(cc) : undefined,
                bcc: bcc.trim() ? parseAddresses(bcc) : undefined,
                subject: subject.trim(),
                bodyText: body,
                attachments:
                    attachments.length > 0
                        ? attachments.map(({ filename, mimeType, contentBase64 }) => ({
                              filename,
                              mimeType,
                              contentBase64
                          }))
                        : undefined
            });
            close(true);
        } catch (e) {
            setError(humanizeError(e, 'Envoi impossible.'));
        } finally {
            setSending(false);
        }
    }

    return (
        <Popup
            id={COMPOSE_POPUP}
            title='Nouveau message'
            width={670}
            onInputChange={handleOpen}
            onClosePopup={() => close(false)}
            onSubmit={() => void send()}
        >
            <div className={styles.form}>
                <div className={styles.composeHeader}>
                    <label className={styles.composeRow}>
                        <span className={styles.composeRowLabel}>De</span>
                        <SelectInput
                            className={styles.composeRowInput}
                            value={accountId ?? ''}
                            onChange={(e) => setAccountId(e.target.value ? Number(e.target.value) : null)}
                        >
                            {accounts.map((a) => (
                                <option key={a.id} value={a.id}>
                                    {a.displayName} ({a.emailAddress})
                                </option>
                            ))}
                        </SelectInput>
                    </label>
                    <label className={styles.composeRow}>
                        <span className={styles.composeRowLabel}>À</span>
                        <TextInput
                            className={styles.composeRowInput}
                            placeholder='Destinataires séparés par des virgules'
                            value={to}
                            onChange={(e) => setTo(e.target.value)}
                        />
                    </label>
                    {advancedOpen && (
                        <>
                            <label className={styles.composeRow}>
                                <span className={styles.composeRowLabel}>Cc</span>
                                <TextInput
                                    className={styles.composeRowInput}
                                    placeholder='Copie'
                                    value={cc}
                                    onChange={(e) => setCc(e.target.value)}
                                />
                            </label>
                            <label className={styles.composeRow}>
                                <span className={styles.composeRowLabel}>Cci</span>
                                <TextInput
                                    className={styles.composeRowInput}
                                    placeholder='Copie cachée'
                                    value={bcc}
                                    onChange={(e) => setBcc(e.target.value)}
                                />
                            </label>
                        </>
                    )}
                    <button
                        type='button'
                        className={`${styles.composeAdvancedToggle} ${advancedOpen ? styles.composeAdvancedToggleOpen : ''}`}
                        onClick={() => setAdvancedOpen((o) => !o)}
                    >
                        <span className={`icon icon-chevron-down ${styles.composeAdvancedIcon}`} />
                        {advancedOpen ? 'Masquer les champs avancés' : 'Cc, Cci…'}
                    </button>
                </div>

                <TextInput placeholder='Objet' value={subject} onChange={(e) => setSubject(e.target.value)} />
                <textarea
                    className={styles.composeBody}
                    placeholder='Votre message…'
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    rows={12}
                />

                <div className={styles.attachmentsField}>
                    <input
                        ref={fileInputRef}
                        type='file'
                        multiple
                        hidden
                        onChange={(e) => {
                            void addFiles(e.target.files);
                            e.target.value = '';
                        }}
                    />
                    <Button
                        type='button'
                        variant='secondary'
                        icon='folder-plus'
                        onClick={() => fileInputRef.current?.click()}
                    >
                        Joindre des fichiers
                    </Button>
                    {attachments.length > 0 && (
                        <div className={styles.attachments}>
                            {attachments.map((att, i) => (
                                <span key={i} className={styles.attachment}>
                                    <span className='icon icon-file' />
                                    <span>{att.filename}</span>
                                    <span className={styles.attachmentSize}>{formatSize(att.size)}</span>
                                    <button
                                        type='button'
                                        className={styles.attachmentRemove}
                                        onClick={() => removeAttachment(i)}
                                        aria-label={`Retirer ${att.filename}`}
                                    >
                                        <span className={`icon icon-x ${styles.attachmentRemoveIcon}`} />
                                    </button>
                                </span>
                            ))}
                        </div>
                    )}
                </div>

                {error && <p className={styles.status}>{error}</p>}
            </div>
            <div className={styles.popupActions}>
                <div className={styles.popupActionsLeft}>
                    <DialogCancelButton>Annuler</DialogCancelButton>
                </div>
                <Button disabled={sending} onClick={() => void send()}>
                    {sending ? 'Envoi…' : 'Envoyer'}
                </Button>
            </div>
        </Popup>
    );
}

export default ComposePopup;
