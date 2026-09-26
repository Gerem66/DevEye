import { useCallback, useEffect, useState } from 'react';
import {
    Button,
    ConfirmDialog,
    humanizeError,
    ReadOnlyNotice,
    SaveButton,
    SegmentedControl,
    settingsStyles as shell,
    Switch,
    TextInput,
    type ConfirmRequest
} from 'deveye-sdk-client';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';
import type { FinanceAccount } from '../contracts/domain';
import { FINANCE_NAME_MAX_LENGTH, FINANCE_NOTE_MAX_LENGTH } from '../contracts/domain';

import ColorPicker from './ColorPicker';
import { api, refreshFinance } from './api';
import { ACCOUNT_KINDS, amountToInput, parseAmount } from './format';
import styles from './style.module.css';

/**
 * L'onglet Général d'un compte : ce que le dialogue de création demandait, la
 * note, l'archivage et le retrait. Le solde de départ est « ce qu'il y avait
 * quand ce livre a commencé » : le changer décale tous les soldes suivants.
 */
export default function AccountPanel({ scope, canWrite, gone }: SettingsPanelProps) {
    const accountId = scope.kind === 'item' ? Number(scope.itemId) : null;
    const [account, setAccount] = useState<FinanceAccount | null>(null);
    const [balance, setBalance] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

    const load = useCallback(async () => {
        if (accountId === null) return;
        try {
            // La liste est courte et déjà la seule lecture des comptes : pas de
            // commande à part pour une ligne.
            const res = await api.send('finance.accountList', { archived: true });
            const found = res.accounts.find((entry) => entry.id === accountId) ?? null;
            if (found === null) setError('Ce compte n’existe plus.');
            setAccount(found);
            if (found) setBalance(amountToInput(found.initialBalance));
        } catch (e) {
            setError(humanizeError(e, 'Ce compte n’a pas pu être lu.'));
        }
    }, [accountId]);

    useEffect(() => {
        void load();
    }, [load]);

    if (account === null) {
        return <p className={error ? shell.notice : shell.empty}>{error ?? 'Chargement…'}</p>;
    }

    const set = (change: Partial<FinanceAccount>) => setAccount((a) => (a ? { ...a, ...change } : a));
    const initialBalance = parseAmount(balance);
    const kind = ACCOUNT_KINDS.find((entry) => entry.id === account.kind);

    const submit = async () => {
        if (busy || accountId === null) return;
        if (account.name.trim() === '') {
            setError('Le compte a besoin d’un nom.');
            throw new Error('name');
        }
        if (initialBalance === null) {
            setError('Le solde de départ est illisible.');
            throw new Error('balance');
        }
        setBusy(true);
        setError(null);
        try {
            await api.send('finance.accountUpdate', {
                accountId,
                account: {
                    name: account.name.trim(),
                    kind: account.kind,
                    color: account.color,
                    initialBalance,
                    note: account.note,
                    archived: account.archived
                }
            });
            refreshFinance();
        } catch (e) {
            setError(humanizeError(e, 'Enregistrement impossible.'));
            throw e;
        } finally {
            setBusy(false);
        }
    };

    const remove = () => {
        if (accountId === null) return;
        setConfirm({
            title: `Retirer ${account.name} ?`,
            description: 'Ce compte n’a aucune opération. Son retrait est définitif.',
            confirmLabel: 'Retirer',
            tone: 'danger',
            onConfirm: () => {
                void (async () => {
                    setBusy(true);
                    try {
                        await api.send('finance.accountRemove', { accountId });
                        // `gone()` d'abord : ravivée avant, la fiche irait chercher un compte disparu.
                        gone();
                        refreshFinance();
                    } catch (e) {
                        // La phrase du serveur dit ce qui bloque (une échéance, par exemple).
                        setError(humanizeError(e, 'Ce compte n’a pas pu être retiré.'));
                    } finally {
                        setBusy(false);
                        setConfirm(null);
                    }
                })();
            }
        });
    };

    const used = account.transactionCount;

    return (
        <div className={shell.section}>
            <label className={shell.field}>
                <span className={shell.fieldLabel}>Nom</span>
                <TextInput
                    value={account.name}
                    maxLength={FINANCE_NAME_MAX_LENGTH}
                    disabled={!canWrite}
                    onChange={(e) => set({ name: e.target.value })}
                />
            </label>

            <div className={shell.field}>
                <span className={shell.fieldLabel}>Type</span>
                <SegmentedControl
                    aria-label='Type de compte'
                    value={account.kind}
                    options={ACCOUNT_KINDS.map((entry) => ({ value: entry.id, label: entry.label }))}
                    disabled={!canWrite}
                    onChange={(value) => set({ kind: value })}
                />
                {kind && <span className={shell.fieldHint}>{kind.hint}</span>}
            </div>

            <label className={shell.field}>
                <span className={shell.fieldLabel}>Solde de départ</span>
                <TextInput
                    inputMode='decimal'
                    value={balance}
                    disabled={!canWrite}
                    error={initialBalance === null ? 'Montant illisible' : undefined}
                    onChange={(e) => setBalance(e.target.value)}
                />
                <span className={shell.fieldHint}>
                    Ce qu’il y avait sur le compte avant la première opération saisie ici. Le changer décale tous les
                    soldes qui suivent.
                </span>
            </label>

            <div className={shell.field}>
                <span className={shell.fieldLabel}>Couleur</span>
                <ColorPicker
                    aria-label='Couleur du compte'
                    value={account.color}
                    disabled={!canWrite}
                    onChange={(color) => set({ color })}
                />
            </div>

            <label className={shell.field}>
                <span className={shell.fieldLabel}>Note</span>
                <textarea
                    className={styles.textarea}
                    rows={2}
                    maxLength={FINANCE_NOTE_MAX_LENGTH}
                    placeholder='ex. banque, agence, usage'
                    value={account.note}
                    disabled={!canWrite}
                    onChange={(e) => set({ note: e.target.value })}
                />
            </label>

            <Switch
                checked={account.archived}
                disabled={!canWrite}
                onChange={(archived) => set({ archived })}
                label='Archiver ce compte'
                hint='Il sort des listes de saisie sans rien perdre, et son solde reste compté dans le total.'
            />

            {canWrite ? (
                <>
                    <SaveButton onSave={submit} disabled={busy} />
                    <div className={shell.sectionActions}>
                        {used === 0 ? (
                            <Button variant='danger' onClick={remove} disabled={busy}>
                                Retirer ce compte
                            </Button>
                        ) : (
                            <span className={shell.fieldHint}>
                                {used} opération{used > 1 ? 's portent' : ' porte'} ce compte : il ne peut pas être
                                retiré. Archivez-le pour qu’il sorte des listes sans rien perdre.
                            </span>
                        )}
                    </div>
                </>
            ) : (
                <ReadOnlyNotice>
                    Votre rôle ne permet pas de modifier ce compte : cela relève de l’écriture sur Finances.
                </ReadOnlyNotice>
            )}

            {error && <p className={shell.notice}>{error}</p>}
            <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} busy={busy} />
        </div>
    );
}
