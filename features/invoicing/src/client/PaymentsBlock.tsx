import { useState } from 'react';
import {
    Button,
    ConfirmDialog,
    Dialog,
    DialogCancelButton,
    humanizeError,
    SearchSelect,
    TextInput,
    type ConfirmRequest,
    type SearchSelectOption
} from 'deveye-sdk-client';

import type { InvoicingDoc, InvoicingPayment, PaymentMethod } from '../contracts/domain';
import { api } from './api';
import { amountToInput, formatDate, formatMoney, parseAmount, todayIso } from './format';
import styles from './style.module.css';

/**
 * Les règlements d'une facture. Ce sont des saisies, pas des pièces légales :
 * elles se corrigent et se retirent, contrairement à la facture elle-même.
 */

const METHODS: readonly SearchSelectOption<PaymentMethod>[] = [
    { value: 'transfer', label: 'Virement' },
    { value: 'card', label: 'Carte' },
    { value: 'check', label: 'Chèque' },
    { value: 'cash', label: 'Espèces' },
    { value: 'other', label: 'Autre' }
];

export interface PaymentsBlockProps {
    doc: InvoicingDoc;
    payments: readonly InvoicingPayment[];
    canWrite: boolean;
    onChanged(doc: InvoicingDoc, payments: readonly InvoicingPayment[]): void;
}

export default function PaymentsBlock({ doc, payments, canWrite, onChanged }: PaymentsBlockProps) {
    const [adding, setAdding] = useState(false);
    const [amount, setAmount] = useState('');
    const [paidOn, setPaidOn] = useState(todayIso());
    const [method, setMethod] = useState<PaymentMethod>('transfer');
    const [reference, setReference] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

    const open = () => {
        // Le reste dû est ce qu'on encaisse neuf fois sur dix : le proposer
        // évite de retaper un montant qu'on vient de lire au-dessus.
        setAmount(amountToInput(doc.remainingCents));
        setPaidOn(todayIso());
        setError(null);
        setAdding(true);
    };

    const submit = () => {
        const cents = parseAmount(amount);
        if (busy || cents === null || cents <= 0) {
            setError('Un montant est attendu, par exemple 1 250,50.');
            return;
        }
        setBusy(true);
        setError(null);
        void api
            .send('invoicing.paymentSave', {
                docId: doc.id,
                payment: { paidOn, amountCents: cents, method, reference, note: '' }
            })
            .then((res) => {
                setAdding(false);
                setReference('');
                onChanged(res.doc, res.payments);
            })
            .catch((e) => setError(humanizeError(e, 'Ce règlement n’a pas pu être enregistré.')))
            .finally(() => setBusy(false));
    };

    const remove = (payment: InvoicingPayment) =>
        setConfirm({
            title: 'Retirer ce règlement ?',
            description: `${formatMoney(payment.amountCents, doc.currency)} du ${formatDate(payment.paidOn)}. La facture redeviendra due d’autant.`,
            confirmLabel: 'Retirer',
            tone: 'danger',
            onConfirm: () => {
                setBusy(true);
                void api
                    .send('invoicing.paymentRemove', { docId: doc.id, id: payment.id })
                    .then((res) => onChanged(res.doc, res.payments))
                    .catch((e) => setError(humanizeError(e, 'Ce règlement n’a pas pu être retiré.')))
                    .finally(() => {
                        setBusy(false);
                        setConfirm(null);
                    });
            }
        });

    return (
        <div className={styles.pane}>
            <div className={styles.paneHead}>
                <p className={styles.paneCount}>
                    {payments.length === 0
                        ? 'Aucun règlement enregistré'
                        : `${formatMoney(doc.settledCents, doc.currency)} réglés, ${formatMoney(doc.remainingCents, doc.currency)} restants`}
                </p>
                {canWrite && doc.remainingCents > 0 && (
                    <Button icon='add' onClick={open}>
                        Règlement
                    </Button>
                )}
            </div>

            {error && <p className={styles.error}>{error}</p>}

            {payments.length > 0 && (
                <ul className={styles.rows}>
                    {payments.map((payment) => (
                        <li key={payment.id}>
                            <div className={styles.rowStatic}>
                                <span className={`icon ${styles.rowIcon} icon-finance`} />
                                <span className={styles.rowText}>
                                    <span className={styles.rowLabel}>
                                        {formatMoney(payment.amountCents, doc.currency)}
                                    </span>
                                    <span className={styles.rowMeta}>
                                        {formatDate(payment.paidOn)} ·{' '}
                                        {METHODS.find((m) => m.value === payment.method)?.label ?? payment.method}
                                        {payment.reference.length > 0 && ` · ${payment.reference}`}
                                    </span>
                                </span>
                                {canWrite && (
                                    <button
                                        type='button'
                                        className={styles.lineDrop}
                                        aria-label='Retirer ce règlement'
                                        disabled={busy}
                                        onClick={() => remove(payment)}
                                    >
                                        <span className='icon icon-trash' aria-hidden='true' />
                                    </button>
                                )}
                            </div>
                        </li>
                    ))}
                </ul>
            )}

            <Dialog
                open={adding}
                onClose={() => setAdding(false)}
                onSubmit={submit}
                title='Enregistrer un règlement'
                width={420}
                footer={
                    <>
                        <DialogCancelButton>Annuler</DialogCancelButton>
                        <Button onClick={submit} disabled={busy}>
                            Enregistrer
                        </Button>
                    </>
                }
            >
                <div className={styles.dialogFields}>
                    <label className={styles.dialogField}>
                        <span className={styles.dialogLabel}>Montant reçu</span>
                        <TextInput
                            data-autofocus
                            inputMode='decimal'
                            value={amount}
                            onChange={(e) => setAmount(e.target.value)}
                        />
                        <span className={styles.dialogHint}>
                            Il reste {formatMoney(doc.remainingCents, doc.currency)} à régler.
                        </span>
                    </label>

                    <label className={styles.dialogField}>
                        <span className={styles.dialogLabel}>Date de l’encaissement</span>
                        <TextInput type='date' value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
                        <span className={styles.dialogHint}>
                            C’est elle qui date votre trésorerie, pas la date de la facture.
                        </span>
                    </label>

                    <label className={styles.dialogField}>
                        <span className={styles.dialogLabel}>Moyen</span>
                        <SearchSelect aria-label='Moyen' value={method} onChange={setMethod} options={METHODS} />
                    </label>

                    <label className={styles.dialogField}>
                        <span className={styles.dialogLabel}>Référence</span>
                        <TextInput value={reference} onChange={(e) => setReference(e.target.value)} />
                    </label>

                    {error && <p className={styles.error}>{error}</p>}
                </div>
            </Dialog>

            <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} busy={busy} />
        </div>
    );
}
