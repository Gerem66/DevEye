import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    Button,
    FeatureSettingsButton,
    StatusBadge,
    formatBytesFr,
    humanizeError,
    invalidate,
    useActiveWorkspace,
    useLiveItemTarget,
    useLiveOutlines,
    useResourceVersion,
    useWorkspacePermissions
} from 'deveye-sdk-client';
import type { FeatureViewProps } from '@deveye/types/sdk/client';

import type { Connection, Mailbox } from '../contracts/domain';
import AddressView from './AddressView';
import { api } from './api';
import CreateDialog from './CreateDialog';
import { ago } from './format';
import SecretOnceDialog from './SecretOnceDialog';
import styles from './style.module.css';

/** Les adresses hébergées de l'espace, rangées par domaine. */
export function FeatureMailserver(_props: FeatureViewProps) {
    const canWrite = useWorkspacePermissions().canFeature('mailserver', 'write');
    const workspaceId = useActiveWorkspace()?.id ?? null;
    const listVersion = useResourceVersion('mailserver.list');
    const detailVersion = useResourceVersion('mailserver.get');

    const [mailboxes, setMailboxes] = useState<Mailbox[] | null>(null);
    const [openedId, setOpenedId] = useState<number | null>(null);
    const [opened, setOpened] = useState<{ mailbox: Mailbox; connection: Connection | null } | null>(null);
    const [creating, setCreating] = useState(false);
    const [fresh, setFresh] = useState<{ address: string; password: string } | null>(null);
    const [error, setError] = useState<string | null>(null);

    useLiveItemTarget('l1', openedId === null ? null : String(openedId), mailboxes !== null, (value) => {
        if (value === null) return setOpenedId(null);
        const id = Number(value);
        if (Number.isInteger(id) && mailboxes?.some((m) => m.id === id)) setOpenedId(id);
    });
    const outlineFor = useLiveOutlines('l1');

    useEffect(() => {
        api.send('mailserver.list', {})
            .then((res) => {
                setMailboxes(res.mailboxes);
                setError(null);
            })
            .catch((failure: unknown) => setError(humanizeError(failure, 'Impossible de charger les adresses.')));
    }, [workspaceId, listVersion]);

    const close = useCallback(() => setOpenedId(null), []);

    useEffect(() => {
        if (openedId === null) return setOpened(null);
        api.send('mailserver.get', { id: openedId })
            .then((res) => setOpened(res))
            .catch(() => {
                // Supprimée, ou masquée à ce rôle, depuis un autre écran : la fiche s'en va.
                setOpened(null);
                setOpenedId(null);
            });
    }, [openedId, detailVersion]);

    const byDomain = useMemo(() => {
        const groups = new Map<string, Mailbox[]>();
        for (const mailbox of mailboxes ?? []) {
            groups.set(mailbox.domainHost, [...(groups.get(mailbox.domainHost) ?? []), mailbox]);
        }
        return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
    }, [mailboxes]);

    if (opened && openedId === opened.mailbox.id) {
        return (
            <>
                <AddressView mailbox={opened.mailbox} connection={opened.connection} onBack={close} />
                <SecretOnceDialog
                    secret={fresh?.password ?? null}
                    title='Mot de passe de la boîte'
                    address={fresh?.address ?? ''}
                    onClose={() => setFresh(null)}
                />
            </>
        );
    }

    return (
        <div className={styles.root}>
            <header className={styles.header}>
                <div>
                    <h2 className={styles.heading}>Serveur mail</h2>
                    {mailboxes && (
                        <p className={styles.subheading}>
                            {mailboxes.length} adresse{mailboxes.length > 1 ? 's' : ''} sur {byDomain.length} domaine
                            {byDomain.length > 1 ? 's' : ''}
                        </p>
                    )}
                </div>
                <div className={styles.actions}>
                    <FeatureSettingsButton scope={{ kind: 'feature', feature: 'mailserver' }} />
                    {canWrite && (
                        <Button icon='add' onClick={() => setCreating(true)}>
                            Nouvelle adresse
                        </Button>
                    )}
                </div>
            </header>

            {error && <p className={styles.error}>{error}</p>}
            {mailboxes === null && !error && <p className={styles.hint}>Chargement…</p>}
            {mailboxes?.length === 0 && (
                <p className={styles.hint}>
                    Aucune adresse pour l’instant.
                    {canWrite && ' Déclarez un domaine dans les réglages, puis créez la première.'}
                </p>
            )}

            {byDomain.map(([host, group]) => (
                <section key={host} className={styles.group}>
                    <h3 className={styles.groupTitle}>
                        <span className='icon icon-globe' aria-hidden='true' />
                        {host}
                    </h3>
                    <ul className={styles.list}>
                        {group.map((mailbox) => (
                            <li key={mailbox.id}>
                                <button
                                    type='button'
                                    className={styles.card}
                                    {...outlineFor(String(mailbox.id))}
                                    onClick={() => setOpenedId(mailbox.id)}
                                >
                                    <span className={`icon icon-at ${styles.cardIcon}`} aria-hidden='true' />
                                    <span className={styles.cardText}>
                                        <span className={styles.cardTitle}>{mailbox.address}</span>
                                        <span className={styles.cardMeta}>
                                            {mailbox.displayName ? `${mailbox.displayName} · ` : ''}
                                            {formatBytesFr(mailbox.usedBytes)} · dernier message{' '}
                                            {ago(mailbox.lastDeliveryAt)}
                                        </span>
                                    </span>
                                    {!mailbox.enabled && <StatusBadge tone='neutral'>Éteinte</StatusBadge>}
                                    {mailbox.foreign && <StatusBadge tone='accent'>Partagée</StatusBadge>}
                                    <span className={`icon icon-arrow ${styles.cardArrow}`} aria-hidden='true' />
                                </button>
                            </li>
                        ))}
                    </ul>
                </section>
            ))}

            <CreateDialog
                open={creating}
                onClose={() => setCreating(false)}
                onCreated={(mailbox, password) => {
                    setCreating(false);
                    setFresh({ address: mailbox.address, password });
                    invalidate('mailserver.list', 'mailserver.count');
                    setOpenedId(mailbox.id);
                }}
            />
            <SecretOnceDialog
                secret={fresh?.password ?? null}
                title='Mot de passe de la boîte'
                address={fresh?.address ?? ''}
                onClose={() => setFresh(null)}
            />
        </div>
    );
}

export default FeatureMailserver;
