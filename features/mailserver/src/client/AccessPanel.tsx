import { useState } from 'react';
import {
    Button,
    ConfirmDialog,
    Dialog,
    ReadOnlyNotice,
    TextInput,
    humanizeError,
    invalidate,
    settingsStyles as shell,
    useResource,
    useWorkspacePermissions,
    type ConfirmRequest
} from 'deveye-sdk-client';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';

import { MAILSERVER_NAME_MAX, type Credential } from '../contracts/domain';
import { api } from './api';
import { ago } from './format';
import SecretOnceDialog from './SecretOnceDialog';

/**
 * Les mots de passe d'application d'une adresse : un par client (téléphone,
 * Thunderbird, Mails), pour pouvoir en révoquer un sans déconnecter les autres
 * ni toucher au mot de passe de la boîte.
 */
export default function AccessPanel({ scope, canWrite }: SettingsPanelProps) {
    const mailboxId = scope.kind === 'item' ? Number(scope.itemId) : 0;
    const address = scope.kind === 'item' ? scope.itemLabel : '';
    const permissions = useWorkspacePermissions();
    const canManage = canWrite && permissions.canExtra('mailserver', 'managePasswords', String(mailboxId));
    const { data, error: loadError } = useResource(
        'mailserver.appPasswordList',
        () => api.send('mailserver.appPasswordList', { id: mailboxId }).then((res) => res.credentials),
        'Les mots de passe d’application n’ont pas pu être lus.',
        [mailboxId]
    );

    const [label, setLabel] = useState<string | null>(null);
    const [secret, setSecret] = useState<string | null>(null);
    const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const run = async (work: () => Promise<void>, fallback: string) => {
        setBusy(true);
        setError(null);
        try {
            await work();
            invalidate('mailserver.appPasswordList');
        } catch (failure) {
            setError(humanizeError(failure, fallback));
        } finally {
            setBusy(false);
        }
    };

    const create = () => {
        const wanted = label?.trim() ?? '';
        if (wanted === '') return;
        void run(async () => {
            const res = await api.send('mailserver.appPasswordCreate', {
                id: mailboxId,
                label: wanted,
                forMails: false
            });
            setLabel(null);
            setSecret(res.secret);
        }, 'Ce mot de passe d’application n’a pas pu être créé.');
    };

    const askRevoke = (credential: Credential) =>
        setConfirm({
            title: `Révoquer « ${credential.label} » ?`,
            description:
                credential.origin === 'mails'
                    ? 'Mails ne pourra plus relever cette adresse tant que son compte n’aura pas reçu un nouveau mot de passe.'
                    : 'Le client qui s’en sert est déconnecté, et devra en recevoir un nouveau.',
            confirmLabel: 'Révoquer',
            tone: 'danger',
            onConfirm: () =>
                void run(async () => {
                    await api.send('mailserver.appPasswordRevoke', { id: mailboxId, credentialId: credential.id });
                    setConfirm(null);
                }, 'Ce mot de passe d’application n’a pas pu être révoqué.')
        });

    return (
        <div className={shell.section}>
            <p className={`${shell.sectionHint} ${shell.panelLead}`}>
                Le mot de passe de la boîte donne un accès normal, depuis n’importe quel client. Ceux-ci s’y ajoutent,
                un par client : chacun se révoque seul, sans changer les autres.
            </p>
            {!canManage && (
                <ReadOnlyNotice>Gérer les mots de passe est une permission à part de l’écriture.</ReadOnlyNotice>
            )}

            <div className={shell.channelList}>
                {data?.length === 0 && (
                    <div className={shell.emptyRow}>
                        <span>Aucun mot de passe d’application.</span>
                    </div>
                )}
                {data?.map((credential) => (
                    <div key={credential.id} className={shell.channelRow}>
                        <span className={`icon icon-key ${shell.channelIcon}`} aria-hidden='true' />
                        <span className={shell.channelText}>
                            <span className={shell.channelLabel}>{credential.label}</span>
                            <span className={shell.channelMeta}>
                                Créé {ago(credential.created)} · dernier usage {ago(credential.lastUsedAt)}
                            </span>
                        </span>
                        {canManage && (
                            <span className={shell.channelActions}>
                                <button
                                    type='button'
                                    className={`${shell.rowAction} ${shell.rowActionDanger}`}
                                    title='Révoquer ce mot de passe'
                                    aria-label={`Révoquer ${credential.label}`}
                                    disabled={busy}
                                    onClick={() => askRevoke(credential)}
                                >
                                    <span className='icon icon-trash' />
                                </button>
                            </span>
                        )}
                    </div>
                ))}
            </div>

            {(error ?? loadError) && label === null && <p className={shell.errorText}>{error ?? loadError}</p>}

            {canManage && (
                <div className={shell.sectionActions}>
                    <Button variant='secondary' icon='plus' disabled={busy} onClick={() => setLabel('')}>
                        Nouveau mot de passe d’application
                    </Button>
                </div>
            )}

            <Dialog
                open={label !== null}
                onClose={() => setLabel(null)}
                title='Nouveau mot de passe d’application'
                description='Nommez le client qui s’en servira : c’est ce nom qui permettra de le révoquer.'
                width={440}
                onSubmit={create}
                footer={
                    <>
                        <Button variant='secondary' disabled={busy} onClick={() => setLabel(null)}>
                            Annuler
                        </Button>
                        <Button disabled={busy || (label ?? '').trim() === ''} onClick={create}>
                            Créer
                        </Button>
                    </>
                }
            >
                <label className={shell.field}>
                    <span className={shell.fieldLabel}>Client</span>
                    <TextInput
                        value={label ?? ''}
                        maxLength={MAILSERVER_NAME_MAX}
                        placeholder='Téléphone, Thunderbird du bureau…'
                        autoFocus
                        onChange={(e) => setLabel(e.target.value)}
                    />
                </label>
                {error && <p className={shell.errorText}>{error}</p>}
            </Dialog>

            <SecretOnceDialog
                secret={secret}
                title='Mot de passe d’application'
                address={address}
                onClose={() => setSecret(null)}
            />
            <ConfirmDialog request={confirm} busy={busy} onClose={() => setConfirm(null)} />
        </div>
    );
}
