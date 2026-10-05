import { StatusBadge } from 'deveye-sdk-client';

import type { InvoicingDoc } from '../contracts/domain';
import { deadlineNote, formatDateShort, formatMoney, kindIcon, kindLabel, STATUS_TONE, statusLabel } from './format';
import styles from './style.module.css';

/**
 * Une rangée de document, la même sur l'accueil et dans le journal : deux
 * silhouettes pour la même chose finiraient par se répondre de travers.
 */
export interface DocumentRowProps {
    doc: InvoicingDoc;
    currency: string;
    /** Le montant à droite : le total, ou ce qui reste dû quand c'est ça qui presse. */
    amount?: 'gross' | 'remaining';
    /** Faux sur la fiche du client : son nom y serait répété sur chaque rangée. */
    showClient?: boolean;
    onOpen(): void;
}

export default function DocumentRow({ doc, currency, amount = 'gross', showClient = true, onOpen }: DocumentRowProps) {
    const note = deadlineNote(doc.kind, doc.displayStatus, doc.dueOn, doc.validUntil);
    const meta = [
        showClient ? (doc.clientName.length > 0 ? doc.clientName : 'Sans client') : null,
        doc.issuedOn !== null ? formatDateShort(doc.issuedOn) : 'à rédiger',
        note
    ]
        .filter((part): part is string => part !== null)
        .join(' · ');

    return (
        <button type='button' className={styles.row} onClick={onOpen}>
            <span className={`icon ${styles.rowIcon} icon-${kindIcon(doc.kind)}`} />
            <span className={styles.rowText}>
                <span className={styles.rowLabel}>
                    {doc.numberLabel ?? `${kindLabel(doc.kind)} en préparation`}
                    {doc.subject.length > 0 && <span className={styles.rowSubject}> · {doc.subject}</span>}
                </span>
                <span className={styles.rowMeta}>{meta}</span>
            </span>
            <span className={styles.rowRight}>
                <StatusBadge tone={STATUS_TONE[doc.displayStatus]}>
                    {statusLabel(doc.kind, doc.displayStatus)}
                </StatusBadge>
                <span className={styles.rowAmount}>
                    {formatMoney(amount === 'remaining' ? doc.remainingCents : doc.totals.grossCents, currency)}
                </span>
            </span>
        </button>
    );
}
