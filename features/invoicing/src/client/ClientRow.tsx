import { StatusBadge } from 'deveye-sdk-client';

import type { InvoicingClient } from '../contracts/domain';
import { formatMoney } from './format';
import styles from './style.module.css';

/** Une rangée de client, la même sur l'accueil et dans le carnet. */
export interface ClientRowProps {
    client: InvoicingClient;
    currency: string;
    onOpen(): void;
}

export default function ClientRow({ client, currency, onOpen }: ClientRowProps) {
    const place = [client.postalCode, client.city].filter((part) => part.length > 0).join(' ');
    const documents =
        client.usage.documents > 0
            ? `${client.usage.documents} document${client.usage.documents > 1 ? 's' : ''}`
            : 'Aucun document';
    const meta = [place, documents].filter((part) => part.length > 0).join(' · ');

    return (
        <button type='button' className={styles.row} onClick={onOpen}>
            <span className={`icon ${styles.rowIcon} icon-${client.kind === 'company' ? 'users' : 'user'}`} />
            <span className={styles.rowText}>
                <span className={styles.rowLabel}>{client.name}</span>
                <span className={styles.rowMeta}>{meta}</span>
            </span>
            <span className={styles.rowRight}>
                {client.archived && <StatusBadge tone='neutral'>De côté</StatusBadge>}
                {client.usage.overdueCents > 0 ? (
                    <StatusBadge tone='danger'>
                        {formatMoney(client.usage.overdueCents, currency)} en retard
                    </StatusBadge>
                ) : client.usage.outstandingCents > 0 ? (
                    <span className={styles.rowAmount}>{formatMoney(client.usage.outstandingCents, currency)}</span>
                ) : null}
            </span>
        </button>
    );
}
