import { useEffect, useState } from 'react';
import {
    Button,
    Checkbox,
    Dialog,
    DialogCancelButton,
    ErrorNote,
    moduleClientProvider,
    SegmentedControl,
    SelectInput,
    TextInput,
    useWorkspacePermissions,
    type ErrorNoteInput
} from 'deveye-sdk-client';
import { INVOICING_CLIENT_PROVIDER } from '@deveye/types/sdk';
import type { InvoicingClientProvider } from '@deveye/types/sdk/client';
import type { z } from 'zod';
import type { financeStatementResolve } from '../contracts/commands';
import { FINANCE_COUNTERPARTY_MAX_LENGTH } from '../contracts/domain';
import type { StatementLine, StatementProposal } from '../contracts/statement';

import { api, refreshFinance } from './api';
import { VAT_RATES, formatDate, formatMoney, vatFromGross } from './format';
import { accountName, activeAccounts, errorNote, signOf } from './shared';
import { ruleKeyword } from './statement/keyword';
import styles from './style.module.css';
import type { FinanceBase } from './shared';

type Action = z.input<(typeof financeStatementResolve)['input']>['action'];

interface ResolveDialogProps {
    base: FinanceBase;
    /** Les lignes à rapprocher : une, ou plusieurs du même sens à ranger d'un coup. `null` fermé. */
    lines: StatementLine[] | null;
    onClose: () => void;
}

const VAT_OPTIONS = VAT_RATES.map((rate) => ({
    value: String(rate),
    label: rate === 0 ? 'Aucune' : `${String(rate).replace('.', ',')} %`
}));

/**
 * Ce qu'est une ligne de relevé. D'abord ce que DevEye y reconnaît (une
 * opération déjà au livre, une échéance, une facture), en un clic ; sinon une
 * opération neuve, rangée dans une catégorie, avec la règle qui rangera les
 * suivantes toute seule.
 */
export function ResolveDialog({ base, lines, onClose }: ResolveDialogProps) {
    const invoicing = moduleClientProvider<InvoicingClientProvider>(INVOICING_CLIENT_PROVIDER);
    const canPayInvoices = useWorkspacePermissions().canFeature('invoicing', 'write');
    const [mode, setMode] = useState<'create' | 'transfer'>('create');
    const [categoryId, setCategoryId] = useState<number | null>(null);
    const [counterparty, setCounterparty] = useState('');
    const [vatRate, setVatRate] = useState('0');
    const [ruleOn, setRuleOn] = useState(false);
    const [ruleText, setRuleText] = useState('');
    const [transferTo, setTransferTo] = useState<number | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<ErrorNoteInput | null>(null);

    useEffect(() => {
        if (lines === null) return;
        const keyword = lines.length === 1 ? ruleKeyword(lines[0].label) : '';
        setMode('create');
        setCategoryId(null);
        setCounterparty('');
        setVatRate('0');
        setRuleText(keyword);
        setRuleOn(keyword !== '');
        setTransferTo(null);
        setError(null);
    }, [lines]);

    const first = lines?.[0] ?? null;
    const single = lines !== null && lines.length === 1;
    const directions = new Set(lines?.map((line) => line.direction) ?? []);
    const mixed = directions.size > 1;
    const incoming = first?.direction === 'in';
    const currency = base.config.currency;
    const categories = base.categories.filter((category) => category.flow === (incoming ? 'income' : 'expense'));
    const others = first === null ? [] : activeAccounts(base.accounts).filter((a) => a.id !== first.accountId);
    const total = lines?.reduce((sum, line) => sum + line.amount, 0) ?? 0;

    const resolve = async (action: Action, fallback: string) => {
        if (lines === null || busy) return;
        setBusy(true);
        setError(null);
        try {
            await api.send('finance.statementResolve', { lineIds: lines.map((line) => line.id), action });
            refreshFinance();
            onClose();
        } catch (e) {
            setError(errorNote(e, fallback));
        } finally {
            setBusy(false);
        }
    };

    const recordPayment = async (proposal: Extract<StatementProposal, { kind: 'invoice' }>) => {
        if (first === null || invoicing === undefined || busy) return;
        setBusy(true);
        setError(null);
        try {
            await invoicing.recordPayment({
                docId: proposal.docId,
                paidOn: first.date,
                amountCents: first.amount,
                reference: first.label.slice(0, 120)
            });
            refreshFinance();
            onClose();
        } catch (e) {
            setError(errorNote(e, 'Le règlement n’a pas pu être enregistré dans Facturation.'));
        } finally {
            setBusy(false);
        }
    };

    const submit = () => {
        if (mixed) return;
        if (mode === 'transfer') {
            if (transferTo === null) return;
            void resolve({ kind: 'transfer', accountId: transferTo }, 'Le virement n’a pas pu être inscrit.');
            return;
        }
        const rule =
            ruleOn && categoryId !== null && ruleText.trim().length >= 2 ? { contains: ruleText.trim() } : null;
        void resolve(
            {
                kind: 'create',
                categoryId,
                label: null,
                counterparty: single ? counterparty : '',
                vatRateBp: base.config.vatEnabled ? Math.round(Number(vatRate) * 100) : null,
                rule
            },
            'L’opération n’a pas pu être inscrite.'
        );
    };

    const vatCents = single && first !== null ? vatFromGross(first.amount, Number(vatRate)) : 0;
    const canSubmit = !busy && !mixed && (mode === 'create' || transferTo !== null);

    return (
        <Dialog
            open={lines !== null}
            onClose={onClose}
            title={single ? 'Rapprocher la ligne' : `Ranger ${lines?.length ?? 0} lignes`}
            description={
                first === null
                    ? undefined
                    : single
                      ? `« ${first.label || 'Sans libellé'} », ${signOf(incoming ? 'income' : 'expense')}${formatMoney(first.amount, currency)} le ${formatDate(first.date)} sur « ${accountName(base.accounts, first.accountId)} ».`
                      : `${formatMoney(total, currency)} au total. Chacune devient une opération, à sa date et à son montant.`
            }
            width={520}
            onSubmit={submit}
            footer={
                <>
                    <Button
                        variant='ghost'
                        className={styles.footerStart}
                        disabled={busy}
                        title='Un mouvement qui n’a rien à faire au livre : personnel, ou compté ailleurs'
                        onClick={() => void resolve({ kind: 'ignore' }, 'Impossible d’écarter cette ligne.')}
                    >
                        Écarter
                    </Button>
                    <DialogCancelButton>Annuler</DialogCancelButton>
                    <Button onClick={submit} disabled={!canSubmit}>
                        {busy ? 'Enregistrement…' : mode === 'transfer' ? 'Inscrire le virement' : 'Inscrire'}
                    </Button>
                </>
            }
        >
            {first !== null && (
                <div className={styles.form}>
                    {single && first.proposals.length > 0 && (
                        <div className={styles.field}>
                            <span className={styles.fieldLabel}>Ce que DevEye y reconnaît</span>
                            <ul className={styles.rows}>
                                {first.proposals.map((proposal) => (
                                    <li key={keyOf(proposal)} className={styles.rowStatic}>
                                        <span className={styles.rowText}>
                                            <span className={styles.rowLabel}>
                                                <span className={styles.rowLabelText}>{titleOf(proposal)}</span>
                                            </span>
                                            <span className={styles.rowMeta}>{metaOf(proposal)}</span>
                                        </span>
                                        {proposal.kind === 'transaction' && (
                                            <Button
                                                variant='secondary'
                                                disabled={busy}
                                                onClick={() =>
                                                    void resolve(
                                                        { kind: 'link', transactionId: proposal.transactionId },
                                                        'Le rapprochement n’a pas pu être fait.'
                                                    )
                                                }
                                            >
                                                C’est elle
                                            </Button>
                                        )}
                                        {proposal.kind === 'recurring' && (
                                            <Button
                                                variant='secondary'
                                                disabled={busy}
                                                onClick={() =>
                                                    void resolve(
                                                        { kind: 'post', recurringId: proposal.recurringId },
                                                        'L’échéance n’a pas pu être enregistrée.'
                                                    )
                                                }
                                            >
                                                Enregistrer
                                            </Button>
                                        )}
                                        {proposal.kind === 'invoice' && invoicing !== undefined && canPayInvoices && (
                                            <Button
                                                variant='secondary'
                                                disabled={busy}
                                                onClick={() => void recordPayment(proposal)}
                                            >
                                                Encaisser
                                            </Button>
                                        )}
                                    </li>
                                ))}
                            </ul>
                            {first.proposals.some((p) => p.kind === 'invoice') && (
                                <span className={styles.fieldHint}>
                                    {invoicing !== undefined && canPayInvoices
                                        ? 'Encaisser enregistre le règlement dans Facturation, à la date de la banque : la facture passe payée et la ligne se range toute seule.'
                                        : 'Un membre qui écrit dans Facturation peut y enregistrer ce règlement : la ligne se rangera toute seule.'}
                                </span>
                            )}
                        </div>
                    )}

                    {mixed ? (
                        <ErrorNote
                            note={{
                                message:
                                    'Ces lignes mêlent des entrées et des sorties : rangez-les séparément, elles ne vont pas dans les mêmes catégories.',
                                code: null
                            }}
                        />
                    ) : (
                        <>
                            {single && others.length > 0 && (
                                <div className={styles.field}>
                                    <span className={styles.fieldLabel}>
                                        {first.proposals.length > 0 ? 'Sinon, c’est' : 'C’est'}
                                    </span>
                                    <SegmentedControl
                                        aria-label='Nature de la ligne'
                                        value={mode}
                                        options={[
                                            { value: 'create', label: incoming ? 'Une recette' : 'Une dépense' },
                                            { value: 'transfer', label: 'Un virement entre comptes' }
                                        ]}
                                        onChange={setMode}
                                    />
                                </div>
                            )}

                            {mode === 'transfer' ? (
                                <label className={styles.field}>
                                    <span className={styles.fieldLabel}>
                                        {incoming ? 'Venu du compte' : 'Vers le compte'}
                                    </span>
                                    <SelectInput
                                        value={transferTo ?? ''}
                                        onChange={(e) =>
                                            setTransferTo(e.target.value === '' ? null : Number(e.target.value))
                                        }
                                    >
                                        <option value=''>Choisir…</option>
                                        {others.map((account) => (
                                            <option key={account.id} value={account.id}>
                                                {account.name}
                                            </option>
                                        ))}
                                    </SelectInput>
                                    <span className={styles.fieldHint}>
                                        L’autre moitié se rangera d’elle-même quand le relevé de ce compte arrivera.
                                    </span>
                                </label>
                            ) : (
                                <>
                                    <div className={styles.formRow}>
                                        <label className={styles.field}>
                                            <span className={styles.fieldLabel}>Catégorie</span>
                                            <SelectInput
                                                value={categoryId ?? ''}
                                                onChange={(e) =>
                                                    setCategoryId(e.target.value === '' ? null : Number(e.target.value))
                                                }
                                            >
                                                <option value=''>Sans catégorie</option>
                                                {categories.map((category) => (
                                                    <option key={category.id} value={category.id}>
                                                        {category.name}
                                                    </option>
                                                ))}
                                            </SelectInput>
                                        </label>
                                        {single && (
                                            <label className={styles.field}>
                                                <span className={styles.fieldLabel}>
                                                    {incoming ? 'Client' : 'Fournisseur'} (facultatif)
                                                </span>
                                                <TextInput
                                                    placeholder={incoming ? 'ex. Dupont SARL' : 'ex. OVHcloud'}
                                                    maxLength={FINANCE_COUNTERPARTY_MAX_LENGTH}
                                                    value={counterparty}
                                                    onChange={(e) => setCounterparty(e.target.value)}
                                                />
                                            </label>
                                        )}
                                    </div>

                                    {base.config.vatEnabled && (
                                        <div className={styles.field}>
                                            <span className={styles.fieldLabel}>TVA</span>
                                            <SegmentedControl
                                                aria-label='Taux de TVA'
                                                value={vatRate}
                                                options={VAT_OPTIONS}
                                                onChange={setVatRate}
                                            />
                                            <span className={styles.fieldHint}>
                                                {vatCents === 0
                                                    ? 'Le montant de la banque est le montant total, TVA comprise.'
                                                    : `Soit ${formatMoney(vatCents, currency)} de TVA.`}
                                            </span>
                                        </div>
                                    )}

                                    {single && (
                                        <div className={styles.field}>
                                            <Checkbox
                                                checked={ruleOn && categoryId !== null}
                                                disabled={categoryId === null}
                                                onChange={setRuleOn}
                                            >
                                                Ranger ainsi, à l’avenir, les lignes qui contiennent
                                            </Checkbox>
                                            <TextInput
                                                aria-label='Texte que la règle reconnaît'
                                                placeholder='ex. ovh'
                                                maxLength={80}
                                                disabled={!ruleOn || categoryId === null}
                                                value={ruleText}
                                                onChange={(e) => setRuleText(e.target.value)}
                                            />
                                            <span className={styles.fieldHint}>
                                                {categoryId === null
                                                    ? 'Choisissez une catégorie pour que DevEye s’en souvienne.'
                                                    : 'Les lignes en attente qui le contiennent se rangent aussitôt, les suivantes dès leur import. Les règles se revoient dans les réglages.'}
                                            </span>
                                        </div>
                                    )}
                                </>
                            )}
                        </>
                    )}

                    <ErrorNote note={error} />
                </div>
            )}
        </Dialog>
    );
}

function keyOf(proposal: StatementProposal): string {
    if (proposal.kind === 'transaction') return `t${proposal.transactionId}`;
    if (proposal.kind === 'recurring') return `r${proposal.recurringId}`;
    return `i${proposal.docId}`;
}

/** Ce qu'une proposition désigne, en une ligne. */
export function titleOf(proposal: StatementProposal): string {
    if (proposal.kind === 'transaction') return `« ${proposal.label || 'Sans intitulé'} »`;
    if (proposal.kind === 'recurring') return `L’échéance « ${proposal.label || 'Sans intitulé'} »`;
    return `Facture ${proposal.docNumber}${proposal.clientName ? ` de ${proposal.clientName}` : ''}`;
}

function metaOf(proposal: StatementProposal): string {
    if (proposal.kind === 'transaction') return `Déjà au livre, le ${formatDate(proposal.date)}`;
    if (proposal.kind === 'recurring') return `Prévue le ${formatDate(proposal.date)}`;
    return 'Attend exactement ce montant';
}

export default ResolveDialog;
