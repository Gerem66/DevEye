import { useEffect, useState } from 'react';
import {
    Button,
    ConfirmDialog,
    ReadOnlyNotice,
    SaveButton,
    Switch,
    TextInput,
    humanizeError,
    invalidate,
    settingsStyles as shell,
    useWorkspacePermissions,
    type ConfirmRequest
} from 'deveye-sdk-client';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';

import {
    MAILSERVER_DAILY_LIMIT_MAX,
    MAILSERVER_NAME_MAX,
    MAILSERVER_QUOTA_MB_MAX,
    MAILSERVER_QUOTA_MB_MIN,
    type Connection,
    type Mailbox
} from '../contracts/domain';
import { api } from './api';
import SecretOnceDialog from './SecretOnceDialog';
import ServerPanel from './ServerPanel';
import { useMailsLink } from './useMailsLink';

/** L'onglet Général : l'état du serveur à l'échelle de la fonctionnalité, la boîte elle-même à celle d'une adresse. */
export default function GeneralPanel(props: SettingsPanelProps) {
    if (props.scope.kind === 'feature') return <ServerPanel />;
    return <MailboxPanel {...props} mailboxId={Number(props.scope.itemId)} />;
}

function MailboxPanel({ canWrite, gone, mailboxId }: SettingsPanelProps & { mailboxId: number }) {
    const [held, setHeld] = useState<{ mailbox: Mailbox; connection: Connection | null } | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        api.send('mailserver.get', { id: mailboxId })
            .then(setHeld)
            .catch((failure: unknown) => setError(humanizeError(failure, 'Cette adresse n’a pas pu être lue.')));
    }, [mailboxId]);

    if (error && !held) return <p className={shell.errorText}>{error}</p>;
    if (!held) return <p className={shell.sectionHint}>Chargement…</p>;
    return (
        <MailboxForm
            key={held.mailbox.id}
            {...held}
            canWrite={canWrite}
            gone={gone}
            onChanged={(mailbox) => setHeld({ ...held, mailbox })}
        />
    );
}

function MailboxForm({
    mailbox,
    connection,
    canWrite,
    gone,
    onChanged
}: {
    mailbox: Mailbox;
    connection: Connection | null;
    canWrite: boolean;
    gone: () => void;
    onChanged: (mailbox: Mailbox) => void;
}) {
    const permissions = useWorkspacePermissions();
    const editable = canWrite && !mailbox.foreign;
    const canPasswords = editable && permissions.canExtra('mailserver', 'managePasswords', String(mailbox.id));
    const link = useMailsLink(mailbox, connection);

    const [displayName, setDisplayName] = useState(mailbox.displayName);
    const [quotaMb, setQuotaMb] = useState(mailbox.quotaMb);
    const [dailyLimit, setDailyLimit] = useState(mailbox.outboundDailyLimit);
    const [enabled, setEnabled] = useState(mailbox.enabled);
    const [secret, setSecret] = useState<string | null>(null);
    const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const refresh = () => invalidate('mailserver.list', 'mailserver.get', 'mailserver.count');
    const unchanged =
        displayName === mailbox.displayName &&
        quotaMb === mailbox.quotaMb &&
        dailyLimit === mailbox.outboundDailyLimit &&
        enabled === mailbox.enabled;
    const valid =
        quotaMb >= MAILSERVER_QUOTA_MB_MIN &&
        quotaMb <= MAILSERVER_QUOTA_MB_MAX &&
        dailyLimit >= 0 &&
        dailyLimit <= MAILSERVER_DAILY_LIMIT_MAX;

    const save = async () => {
        setError(null);
        try {
            const res = await api.send('mailserver.update', {
                id: mailbox.id,
                displayName,
                quotaMb,
                enabled,
                outboundDailyLimit: dailyLimit
            });
            onChanged(res.mailbox);
            refresh();
        } catch (failure) {
            setError(humanizeError(failure, 'Ces réglages n’ont pas pu être enregistrés.'));
            throw failure;
        }
    };

    const act = async (work: () => Promise<void>, fallback: string) => {
        setBusy(true);
        setError(null);
        try {
            await work();
        } catch (failure) {
            setError(humanizeError(failure, fallback));
        } finally {
            setBusy(false);
        }
    };

    const setBanner = (dismissed: boolean) =>
        void act(async () => {
            const res = await api.send('mailserver.setBanner', { id: mailbox.id, dismissed });
            onChanged(res.mailbox);
            refresh();
        }, 'Ce réglage n’a pas pu être changé.');

    const askReset = () =>
        setConfirm({
            title: 'Réinitialiser le mot de passe ?',
            description:
                'L’ancien cesse de marcher tout de suite, et les clients connectés avec lui sont déconnectés. Les mots de passe d’application ne changent pas.',
            confirmLabel: 'Réinitialiser',
            tone: 'danger',
            onConfirm: () =>
                void act(async () => {
                    setSecret((await api.send('mailserver.passwordReset', { id: mailbox.id })).password);
                    setConfirm(null);
                }, 'Le mot de passe n’a pas pu être réinitialisé.')
        });

    const askDelete = () =>
        setConfirm({
            title: `Supprimer ${mailbox.address} ?`,
            description: `La boîte et ses ${mailbox.messageCount} message(s) sont effacés pour de bon. Le courrier qui lui sera adressé ensuite sera refusé.`,
            confirmLabel: 'Supprimer',
            tone: 'danger',
            onConfirm: () =>
                void act(async () => {
                    await api.send('mailserver.delete', { id: mailbox.id });
                    setConfirm(null);
                    // La fiche s'en va AVANT que ses ressources ne se relisent sur une adresse disparue.
                    gone();
                    refresh();
                }, 'Cette adresse n’a pas pu être supprimée.')
        });

    const linked = typeof link.linkedId === 'number';

    return (
        <div className={shell.section}>
            {!editable && (
                <ReadOnlyNotice>
                    {mailbox.foreign
                        ? 'Cette adresse appartient à un autre espace : elle se règle depuis là-bas.'
                        : 'Régler une adresse demande le droit d’écriture.'}
                </ReadOnlyNotice>
            )}

            <div className={shell.field}>
                <span className={shell.fieldLabel}>Adresse</span>
                <TextInput value={mailbox.address} disabled readOnly />
                <span className={shell.fieldHint}>
                    Elle ne se change pas : ce serait une autre boîte pour tous ses correspondants.
                </span>
            </div>
            <label className={shell.field}>
                <span className={shell.fieldLabel}>Nom affiché</span>
                <TextInput
                    value={displayName}
                    maxLength={MAILSERVER_NAME_MAX}
                    disabled={!editable}
                    onChange={(e) => setDisplayName(e.target.value)}
                />
            </label>
            <label className={shell.field}>
                <span className={shell.fieldLabel}>Espace de stockage (Mo)</span>
                <TextInput
                    type='number'
                    value={String(quotaMb)}
                    min={MAILSERVER_QUOTA_MB_MIN}
                    max={MAILSERVER_QUOTA_MB_MAX}
                    disabled={!editable}
                    onChange={(e) => setQuotaMb(Number(e.target.value))}
                />
                <span className={shell.fieldHint}>Pleine, la boîte refuse le courrier au lieu de le perdre.</span>
            </label>
            <label className={shell.field}>
                <span className={shell.fieldLabel}>Envois autorisés par jour</span>
                <TextInput
                    type='number'
                    value={String(dailyLimit)}
                    min={0}
                    max={MAILSERVER_DAILY_LIMIT_MAX}
                    disabled={!editable}
                    onChange={(e) => setDailyLimit(Number(e.target.value))}
                />
                <span className={shell.fieldHint}>
                    Ce que ferait un mot de passe volé s’arrête là. La réputation du serveur est commune à toutes les
                    adresses.
                </span>
            </label>
            <Switch
                checked={enabled}
                disabled={!editable}
                onChange={setEnabled}
                label='Adresse active'
                hint='Éteinte, elle refuse le courrier entrant et toute connexion, sans rien effacer.'
            />
            {editable && <SaveButton onSave={save} disabled={unchanged || !valid} />}

            {link.available && (
                <div className={shell.section}>
                    <span className={shell.sectionLabel}>Mail</span>
                    <Switch
                        checked={!mailbox.bannerDismissed && !linked}
                        disabled={!editable || linked || busy}
                        onChange={(shown) => setBanner(!shown)}
                        label='Proposer de lire cette adresse dans Mail'
                        hint={
                            linked
                                ? 'Déjà dans Mail : il n’y a plus rien à proposer.'
                                : 'La proposition s’affiche en haut de la fiche de l’adresse.'
                        }
                    />
                    <div className={shell.sectionActions}>
                        {linked ? (
                            <Button variant='secondary' icon='mail' onClick={link.open}>
                                Ouvrir dans Mail
                            </Button>
                        ) : (
                            canPasswords && (
                                <Button variant='secondary' icon='add' disabled={link.busy} onClick={link.add}>
                                    Ajouter à Mail
                                </Button>
                            )
                        )}
                    </div>
                    {link.error && <p className={shell.errorText}>{link.error}</p>}
                </div>
            )}

            {editable && (
                <div className={shell.section}>
                    <span className={shell.sectionLabel}>Gestes sans retour</span>
                    <div className={shell.sectionActions}>
                        {canPasswords && (
                            <Button variant='secondary' icon='key' disabled={busy} onClick={askReset}>
                                Réinitialiser le mot de passe
                            </Button>
                        )}
                        <Button variant='danger' icon='trash' disabled={busy} onClick={askDelete}>
                            Supprimer l’adresse
                        </Button>
                    </div>
                </div>
            )}

            {error && <p className={shell.errorText}>{error}</p>}
            {link.dialog}
            <SecretOnceDialog
                secret={secret}
                title='Nouveau mot de passe'
                address={mailbox.address}
                onClose={() => setSecret(null)}
            />
            <ConfirmDialog request={confirm} busy={busy} onClose={() => setConfirm(null)} />
        </div>
    );
}
