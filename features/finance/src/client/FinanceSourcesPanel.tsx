import { useState } from 'react';
import {
    Button,
    ConfirmDialog,
    humanizeError,
    openAccountView,
    PlanPausedBadge,
    PlanPausedNotice,
    settingsStyles as shell,
    StatusBadge,
    useResource,
    useWorkspacePermissions,
    type ConfirmRequest
} from 'deveye-sdk-client';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';
import type { BankConnection } from '../contracts/banking';

import ConnectionDialog from './ConnectionDialog';
import { api, refreshFinance } from './api';
import { ConsentError, consentAtBank } from './bankWindow';
import { formatDate } from './format';
import styles from './style.module.css';

/** Un consentement qui finit dans moins de sept jours est à renouveler. */
const RENEW_BEFORE_SECONDS = 7 * 86_400;

/** « il y a 3 h », puis le jour au-delà d'une journée. */
function ago(unix: number): string {
    const seconds = Math.max(0, Math.floor(Date.now() / 1000) - unix);
    if (seconds < 3_600) return `il y a ${Math.max(1, Math.round(seconds / 60))} min`;
    if (seconds < 86_400) return `il y a ${Math.round(seconds / 3_600)} h`;
    return `le ${formatDate(new Date(unix * 1000).toISOString().slice(0, 10))}`;
}

function renewing(connection: BankConnection): boolean {
    return (
        connection.provider === 'enablebanking' &&
        (connection.status === 'expired' ||
            (connection.validUntil !== null && connection.validUntil - Date.now() / 1000 < RENEW_BEFORE_SECONDS))
    );
}

function metaOf(connection: BankConnection): string {
    if (connection.status !== 'ok' && connection.error) return connection.error;
    const count = connection.accounts.length;
    const parts = [
        connection.bankName,
        `${count} compte${count > 1 ? 's' : ''}`,
        connection.lastSyncAt === null ? 'jamais relevée' : `relevée ${ago(connection.lastSyncAt)}`
    ];
    if (connection.validUntil !== null) {
        parts.push(
            `consentement jusqu’au ${formatDate(new Date(connection.validUntil * 1000).toISOString().slice(0, 10))}`
        );
    }
    return parts.join(' · ');
}

/**
 * Les connexions bancaires de l'espace : l'onglet Sources des réglages, seul
 * endroit où elles se créent, se corrigent et se retirent. Un compte du livre
 * en choisit une dans son onglet Banque. Chacune pèse sur l'offre du
 * propriétaire de l'espace, ce que le panneau dit avant tout refus.
 */
export default function FinanceSourcesPanel({ canWrite }: SettingsPanelProps) {
    const { isOwner } = useWorkspacePermissions();
    const { data, error: loadError } = useResource(
        'finance.connectionList',
        () => api.send('finance.connectionList', {}),
        'Impossible de charger les connexions.'
    );
    const [editing, setEditing] = useState<{ connection: BankConnection | null } | null>(null);
    const [busyId, setBusyId] = useState<number | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [flash, setFlash] = useState<string | null>(null);
    const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

    const connections = data?.connections ?? [];
    const uses = (id: number) => data?.links.filter((link) => link.connectionId === id).length ?? 0;
    const quota = data?.quota ?? null;
    const full = quota !== null && quota.used >= quota.limit;
    const pausedCount = connections.filter((c) => c.paused).length;

    const act = async (connection: BankConnection, work: () => Promise<void>, fallback: string) => {
        setBusyId(connection.id);
        setError(null);
        setFlash(null);
        try {
            await work();
        } catch (e) {
            setError(e instanceof ConsentError ? e.message : humanizeError(e, fallback));
        } finally {
            setBusyId(null);
        }
    };

    const sync = (connection: BankConnection) =>
        act(
            connection,
            async () => {
                const res = await api.send('finance.connectionSync', { connectionId: connection.id });
                refreshFinance();
                setFlash(
                    res.connection.status !== 'ok'
                        ? (res.connection.error ?? 'La relève n’a pas abouti.')
                        : res.added === 0
                          ? `« ${connection.label} » : rien de nouveau.`
                          : `« ${connection.label} » : ${res.added} ligne${res.added > 1 ? 's' : ''} nouvelle${res.added > 1 ? 's' : ''}.`
                );
            },
            'La relève a échoué.'
        );

    const reconnect = (connection: BankConnection) =>
        act(
            connection,
            async () => {
                const { authUrl } = await api.send('finance.connectionStart', {
                    connectionId: connection.id,
                    label: connection.label,
                    bank: { name: connection.bankName, country: connection.country ?? 'FR' },
                    psuType: connection.psuType ?? 'business'
                });
                await consentAtBank(authUrl);
                refreshFinance();
                setFlash(`« ${connection.label} » est reconnectée.`);
            },
            'La banque n’a pas pu être reconnectée.'
        );

    const askRemove = (connection: BankConnection) => {
        const used = uses(connection.id);
        setConfirm({
            title: `Retirer « ${connection.label} » ?`,
            description:
                (used === 0
                    ? 'Aucun compte du livre ne la choisit. '
                    : `${used} compte${used > 1 ? 's' : ''} du livre cesse${used > 1 ? 'nt' : ''} d’être relevé${used > 1 ? 's' : ''}. `) +
                'Ce qu’elle a déjà apporté au livre reste, et l’accès donné à DevEye est rendu.',
            confirmLabel: 'Retirer la connexion',
            onConfirm: () =>
                void act(
                    connection,
                    async () => {
                        await api.send('finance.connectionRemove', { connectionId: connection.id });
                        refreshFinance();
                    },
                    'Le retrait a échoué.'
                ).finally(() => setConfirm(null))
        });
    };

    return (
        <div className={shell.section}>
            <p className={shell.sectionHint}>
                Une connexion relève les comptes d’une banque toutes les six heures, et leurs lignes se rapprochent
                comme celles d’un relevé importé. Chaque compte du livre choisit la sienne, dans son onglet Banque.
            </p>

            <PlanPausedNotice count={pausedCount} one='connexion bancaire' many='connexions bancaires' />
            {full && pausedCount === 0 && (
                <div className={styles.planNotice} role='status'>
                    <p>
                        {quota.limit === 0
                            ? 'L’offre de cet espace n’inclut aucune connexion bancaire : l’import de relevé reste possible.'
                            : `L’offre de cet espace permet ${quota.limit} connexion${quota.limit > 1 ? 's' : ''} bancaire${quota.limit > 1 ? 's' : ''}, toutes prises. L’import de relevé reste possible.`}
                        {!isOwner && ' L’offre est celle du propriétaire de l’espace : lui seul peut la changer.'}
                    </p>
                    {isOwner && <Button onClick={() => openAccountView()}>Voir les offres</Button>}
                </div>
            )}

            {data === null && !loadError && <p className={shell.empty}>Chargement…</p>}
            {data !== null && connections.length === 0 && (
                <p className={shell.empty}>
                    {canWrite
                        ? 'Aucune banque reliée. Reliez-en une pour que ses lignes arrivent seules, ou importez vos relevés depuis l’accueil de Finances.'
                        : 'Aucune banque reliée. Un membre disposant du droit d’écriture peut en relier une.'}
                </p>
            )}

            <div className={shell.channelList}>
                {connections.map((connection) => {
                    const used = uses(connection.id);
                    const busy = busyId === connection.id;
                    return (
                        <div key={connection.id} className={shell.channelRow}>
                            <span className={`icon icon-finance ${shell.channelIcon}`} aria-hidden='true' />
                            <span className={shell.channelText}>
                                <span className={shell.channelLabel}>
                                    {connection.label}{' '}
                                    {connection.paused ? (
                                        <PlanPausedBadge />
                                    ) : connection.status === 'expired' ? (
                                        <StatusBadge tone='warning' dot={false}>
                                            Expirée
                                        </StatusBadge>
                                    ) : connection.status === 'error' ? (
                                        <StatusBadge tone='danger' dot={false}>
                                            En échec
                                        </StatusBadge>
                                    ) : renewing(connection) ? (
                                        <StatusBadge tone='warning' dot={false}>
                                            À renouveler
                                        </StatusBadge>
                                    ) : null}
                                </span>
                                <span className={shell.channelMeta}>{metaOf(connection)}</span>
                            </span>
                            <span
                                className={`${shell.channelUsage} ${used === 0 ? shell.channelUsageIdle : ''}`}
                                title={
                                    used === 0
                                        ? 'Choisie par aucun compte du livre'
                                        : `Choisie par ${used} compte${used > 1 ? 's' : ''} du livre`
                                }
                            >
                                {used === 0 ? 'inutilisée' : `${used}×`}
                            </span>
                            {canWrite && (
                                <span className={shell.channelActions}>
                                    {renewing(connection) ? (
                                        <button
                                            type='button'
                                            className={shell.rowAction}
                                            title='Reconnecter : renouveler le consentement chez la banque'
                                            aria-label={`Reconnecter ${connection.label}`}
                                            disabled={busy || connection.paused}
                                            onClick={() => void reconnect(connection)}
                                        >
                                            <span className='icon icon-restart' />
                                        </button>
                                    ) : (
                                        <button
                                            type='button'
                                            className={shell.rowAction}
                                            title='Relever maintenant'
                                            aria-label={`Relever ${connection.label} maintenant`}
                                            disabled={busy || connection.paused || used === 0}
                                            onClick={() => void sync(connection)}
                                        >
                                            <span className='icon icon-refresh' />
                                        </button>
                                    )}
                                    <button
                                        type='button'
                                        className={shell.rowAction}
                                        title='Modifier'
                                        aria-label={`Modifier ${connection.label}`}
                                        disabled={busy}
                                        onClick={() => setEditing({ connection })}
                                    >
                                        <span className='icon icon-edit' />
                                    </button>
                                    <button
                                        type='button'
                                        className={`${shell.rowAction} ${shell.rowActionDanger}`}
                                        title='Retirer'
                                        aria-label={`Retirer ${connection.label}`}
                                        disabled={busy}
                                        onClick={() => askRemove(connection)}
                                    >
                                        <span className='icon icon-trash' />
                                    </button>
                                </span>
                            )}
                        </div>
                    );
                })}
            </div>

            {quota !== null && !full && (
                <p className={shell.fieldHint}>
                    {quota.used} connexion{quota.used > 1 ? 's' : ''} sur {quota.limit} permise
                    {quota.limit > 1 ? 's' : ''} par l’offre.
                </p>
            )}
            {flash && <p className={shell.fieldHint}>{flash}</p>}
            {(error ?? loadError) && <p className={shell.notice}>{error ?? loadError}</p>}

            {canWrite && (
                <div className={shell.sectionActions}>
                    <Button
                        variant='secondary'
                        icon='plus'
                        disabled={busyId !== null || full}
                        onClick={() => setEditing({ connection: null })}
                    >
                        Relier une banque
                    </Button>
                </div>
            )}

            <ConnectionDialog
                open={editing !== null}
                connection={editing?.connection ?? null}
                enableBanking={data?.enableBanking ?? false}
                onClose={() => setEditing(null)}
            />
            <ConfirmDialog request={confirm} busy={busyId !== null} onClose={() => setConfirm(null)} />
        </div>
    );
}
