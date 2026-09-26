import { useRef, useState } from 'react';
import {
    Button,
    FeatureSettingsButton,
    humanizeError,
    ReadOnlyNotice,
    SelectInput,
    settingsStyles as shell,
    useResource
} from 'deveye-sdk-client';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';
import type { BankConnection, BankRemoteAccount } from '../contracts/banking';

import { api, refreshFinance } from './api';
import { formatDate } from './format';

function remoteLabel(account: BankRemoteAccount): string {
    return account.ibanEnd ? `${account.name} (•••• ${account.ibanEnd})` : account.name;
}

/**
 * L'onglet Banque d'un compte du livre : la connexion qui l'alimente, et le
 * compte chez la banque qu'il suit. Il ne fait que choisir : les connexions se
 * créent dans Réglages, Sources, que le « + » ouvre par-dessus, et celle qui y
 * naît est adoptée au retour. Un choix s'applique aussitôt, et la première
 * relève part avec lui.
 */
export default function AccountBankPanel({ scope, canWrite }: SettingsPanelProps) {
    const accountId = scope.kind === 'item' ? Number(scope.itemId) : 0;
    const { data, error: loadError } = useResource(
        'finance.connectionList',
        () => api.send('finance.connectionList', {}),
        'Impossible de charger les connexions.'
    );
    /** `undefined` : suivre ce que le serveur dit du compte. Un nombre ou `null` : un choix en cours. */
    const [picked, setPicked] = useState<number | null | undefined>(undefined);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [flash, setFlash] = useState<string | null>(null);
    const known = useRef<Set<number> | null>(null);

    const connections = data?.connections ?? [];
    const link = data?.links.find((entry) => entry.accountId === accountId) ?? null;
    const selectedId = picked === undefined ? (link?.connectionId ?? null) : picked;
    const selected = connections.find((c) => c.id === selectedId) ?? null;
    const takenBy = (connection: BankConnection, remoteId: string) =>
        data?.links.find(
            (entry) =>
                entry.connectionId === connection.id &&
                entry.externalAccountId === remoteId &&
                entry.accountId !== accountId
        ) ?? null;

    const apply = async (connectionId: number | null, externalAccountId: string | null) => {
        setBusy(true);
        setError(null);
        setFlash(null);
        try {
            const res = await api.send('finance.accountBankLink', { accountId, connectionId, externalAccountId });
            setPicked(undefined);
            refreshFinance();
            if (connectionId !== null) {
                setFlash(
                    res.added === 0
                        ? 'Relié. Rien de nouveau à relever pour l’instant.'
                        : `Relié : ${res.added} ligne${res.added > 1 ? 's' : ''} relevée${res.added > 1 ? 's' : ''}, à retrouver dans Relevés.`
                );
            }
        } catch (e) {
            setError(humanizeError(e, 'Le compte n’a pas pu être relié.'));
        } finally {
            setBusy(false);
        }
    };

    const chooseConnection = (value: string) => {
        if (value === '') {
            if (link !== null) void apply(null, null);
            else setPicked(null);
            return;
        }
        const connection = connections.find((c) => c.id === Number(value));
        if (!connection) return;
        const free = connection.accounts.filter((remote) => takenBy(connection, remote.id) === null);
        // Une connexion à un seul compte libre n'a rien à demander de plus.
        if (connection.accounts.length === 1 && free.length === 1) void apply(connection.id, free[0].id);
        else setPicked(connection.id);
    };

    /** Au retour des Sources, la connexion apparue entre-temps est choisie d'office. */
    const onSettingsOpenChange = (opened: boolean) => {
        if (opened) {
            known.current = new Set(connections.map((c) => c.id));
            return;
        }
        if (known.current === null) return;
        void api
            .send('finance.connectionList', {})
            .then((res) => {
                const fresh = res.connections.find((c) => !known.current?.has(c.id));
                if (!fresh) return;
                if (fresh.accounts.length === 1) void apply(fresh.id, fresh.accounts[0].id);
                else setPicked(fresh.id);
            })
            .catch(() => setError('Impossible de relire les connexions de l’espace.'))
            .finally(() => {
                known.current = null;
            });
    };

    const sync = async () => {
        if (selected === null) return;
        setBusy(true);
        setError(null);
        setFlash(null);
        try {
            const res = await api.send('finance.connectionSync', { connectionId: selected.id });
            refreshFinance();
            setFlash(
                res.connection.status !== 'ok'
                    ? (res.connection.error ?? 'La relève n’a pas abouti.')
                    : res.added === 0
                      ? 'Rien de nouveau.'
                      : `${res.added} ligne${res.added > 1 ? 's' : ''} nouvelle${res.added > 1 ? 's' : ''}, à retrouver dans Relevés.`
            );
        } catch (e) {
            setError(humanizeError(e, 'La relève a échoué.'));
        } finally {
            setBusy(false);
        }
    };

    if (data === null && !loadError) return <p className={shell.empty}>Chargement…</p>;

    const linkedHere = link !== null && selected !== null && link.connectionId === selected.id;

    return (
        <div className={shell.section}>
            <p className={shell.sectionHint}>
                Relié à sa banque, le compte reçoit ses lignes tout seul, toutes les six heures. Sans connexion,
                l’import de relevé fait le même travail, à la main.
            </p>

            <div className={shell.field}>
                <span className={shell.sectionLabel}>Connexion bancaire</span>
                <div className={shell.fieldWithAction}>
                    <SelectInput
                        aria-label='Connexion bancaire'
                        value={selectedId === null ? '' : String(selectedId)}
                        disabled={!canWrite || busy}
                        onChange={(e) => chooseConnection(e.target.value)}
                    >
                        <option value=''>Aucune : import de relevé seulement</option>
                        {connections.map((connection) => (
                            <option key={connection.id} value={connection.id}>
                                {connection.label}
                            </option>
                        ))}
                    </SelectInput>
                    {canWrite && (
                        <FeatureSettingsButton
                            scope={{ kind: 'feature', feature: 'finance' }}
                            initialSection='sources'
                            variant='ghost'
                            label='Connexions'
                            onOpenChange={onSettingsOpenChange}
                        />
                    )}
                </div>
                {connections.length === 0 && (
                    <span className={shell.fieldHint}>
                        Aucune banque reliée dans cet espace : « Connexions » en relie une, Qonto ou une autre.
                    </span>
                )}
            </div>

            {selected !== null && (
                <div className={shell.field}>
                    <span className={shell.sectionLabel}>Compte chez {selected.bankName || 'la banque'}</span>
                    <SelectInput
                        aria-label='Compte chez la banque'
                        value={linkedHere ? link.externalAccountId : ''}
                        disabled={!canWrite || busy}
                        onChange={(e) => e.target.value !== '' && void apply(selected.id, e.target.value)}
                    >
                        {!linkedHere && <option value=''>Choisir le compte…</option>}
                        {selected.accounts.map((remote) => {
                            const taken = takenBy(selected, remote.id) !== null;
                            return (
                                <option key={remote.id} value={remote.id} disabled={taken}>
                                    {remoteLabel(remote)}
                                    {taken ? ' : déjà relié à un autre compte' : ''}
                                </option>
                            );
                        })}
                    </SelectInput>
                    {linkedHere && (
                        <span className={shell.fieldHint}>
                            Relevé depuis le {formatDate(link.since)} : ce qui précède vient de vos imports, ou du solde
                            de départ.
                        </span>
                    )}
                </div>
            )}

            {linkedHere && (
                <div className={shell.sectionActions}>
                    <Button
                        variant='secondary'
                        icon='refresh'
                        disabled={!canWrite || busy || selected.paused || selected.status === 'expired'}
                        onClick={() => void sync()}
                    >
                        {busy ? 'Relève…' : 'Relever maintenant'}
                    </Button>
                </div>
            )}
            {linkedHere && selected.status !== 'ok' && selected.error && (
                <p className={shell.notice}>{selected.error}</p>
            )}
            {linkedHere && selected.status === 'expired' && !selected.error && (
                <p className={shell.notice}>
                    Le consentement donné à la banque a pris fin : reconnectez-la dans Réglages, Sources.
                </p>
            )}

            {flash && <p className={shell.fieldHint}>{flash}</p>}
            {(error ?? loadError) && <p className={shell.notice}>{error ?? loadError}</p>}
            {!canWrite && (
                <ReadOnlyNotice>
                    Votre rôle ne permet pas de relier ce compte : cela relève de l’écriture sur Finances.
                </ReadOnlyNotice>
            )}
        </div>
    );
}
