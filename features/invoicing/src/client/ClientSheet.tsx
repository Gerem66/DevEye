import { useCallback, useEffect, useState } from 'react';
import { Button, FeatureSettingsButton, humanizeError, StatusBadge } from 'deveye-sdk-client';

import type { InvoicingClient } from '../contracts/domain';
import { api } from './api';
import { formatMoney } from './format';
import styles from './style.module.css';

/**
 * La fiche d'un client. Elle se charge par son identifiant plutôt que de lire
 * une liste qu'un écran voisin aurait sous la main : celle-ci pouvait être en
 * retard d'un rafraîchissement, et la fiche s'ouvrait alors vide.
 *
 * Son identité ne se modifie pas ici : elle vit dans l'onglet Général de ses
 * réglages, au bout de la rangée d'en-tête, comme pour tout élément de l'app.
 */
export interface ClientSheetProps {
    id: number;
    currency: string;
    /** Ce que le bouton de retour annonce : d'où l'on vient. */
    backLabel: string;
    onBack(): void;
    /** L'élément n'est plus là : la fiche s'en va. */
    onGone(): void;
}

export default function ClientSheet({ id, currency, backLabel, onBack, onGone }: ClientSheetProps) {
    const [client, setClient] = useState<InvoicingClient | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            const res = await api.send('invoicing.clientList', { archived: true });
            const found = res.clients.find((entry) => entry.id === id) ?? null;
            if (found === null) setError('Ce client n’existe plus.');
            setClient(found);
        } catch (e) {
            setError(humanizeError(e, 'Ce client n’a pas pu être lu.'));
        }
    }, [id]);

    useEffect(() => {
        void load();
    }, [load]);

    if (client === null) {
        return (
            <div className={styles.page}>
                <header className={styles.pageHead}>
                    <Button variant='ghost' icon='arrow-left' onClick={onBack}>
                        {backLabel}
                    </Button>
                </header>
                <p className={error !== null ? styles.error : styles.placeholder}>{error ?? 'Chargement…'}</p>
            </div>
        );
    }

    const place = [
        client.address,
        [client.postalCode, client.city].filter((part) => part.length > 0).join(' '),
        client.country
    ]
        .filter((part) => part.length > 0)
        .join(', ');

    return (
        <div className={styles.page}>
            <header className={styles.header}>
                <div className={styles.detailHead}>
                    <Button variant='ghost' icon='arrow-left' onClick={onBack}>
                        {backLabel}
                    </Button>
                    <div className={styles.ident}>
                        <h2 className={styles.heading}>{client.name}</h2>
                        <p className={styles.subheading}>
                            {client.archived && <StatusBadge tone='neutral'>De côté</StatusBadge>}
                            {client.kind === 'company' ? 'Entreprise' : 'Particulier'}
                            {place.length > 0 && ` · ${place}`}
                        </p>
                    </div>
                </div>
                <div className={styles.actions}>
                    <FeatureSettingsButton
                        scope={{
                            kind: 'item',
                            feature: 'invoicing',
                            itemId: String(client.id),
                            itemLabel: client.name
                        }}
                        onGone={onGone}
                        onOpenChange={(open) => {
                            if (!open) void load();
                        }}
                    />
                </div>
            </header>

            <dl className={styles.figures}>
                <div className={styles.figure}>
                    <dt>Facturé</dt>
                    <dd>{formatMoney(client.usage.billedCents, currency)}</dd>
                </div>
                <div className={styles.figure}>
                    <dt>Reste à encaisser</dt>
                    <dd>{formatMoney(client.usage.outstandingCents, currency)}</dd>
                </div>
                <div className={`${styles.figure} ${client.usage.overdueCents > 0 ? styles.figureBad : ''}`}>
                    <dt>En retard</dt>
                    <dd>{formatMoney(client.usage.overdueCents, currency)}</dd>
                </div>
                <div className={styles.figure}>
                    <dt>Documents</dt>
                    <dd>{client.usage.documents}</dd>
                </div>
            </dl>

            {(client.email.length > 0 || client.phone.length > 0 || client.contactName.length > 0) && (
                <p className={styles.sheetContact}>
                    {[client.contactName, client.email, client.phone].filter((part) => part.length > 0).join(' · ')}
                </p>
            )}
        </div>
    );
}
