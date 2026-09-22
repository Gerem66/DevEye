import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    Button,
    SegmentedControl,
    SelectInput,
    TextInput,
    useResource,
    useWorkspacePermissions
} from 'deveye-sdk-client';

import type { DocumentKind, DocumentStatus } from '../contracts/domain';
import DocumentRow from './DocumentRow';
import { api } from './api';
import { formatMoney } from './format';
import styles from './style.module.css';

/**
 * Le journal complet. Les filtres tiennent sur **une** ligne, dans l'ordre où on
 * les cherche : le type, l'état, l'année, le numéro. Un seul déroulant pour
 * l'état, qui mêle ce qui est stocké et ce qui se déduit : l'utilisateur ne
 * connaît pas cette différence et n'a pas à la connaître.
 */

type DerivedFilter = 'overdue' | 'unpaid' | 'expired';

const STATES: { value: string; label: string; status: DocumentStatus | null; derived: DerivedFilter | null }[] = [
    { value: 'all', label: 'Tous les états', status: null, derived: null },
    { value: 'draft', label: 'Brouillons', status: 'draft', derived: null },
    { value: 'sent', label: 'Envoyés', status: 'sent', derived: null },
    { value: 'accepted', label: 'Devis acceptés', status: 'accepted', derived: null },
    { value: 'declined', label: 'Devis refusés', status: 'declined', derived: null },
    { value: 'expired', label: 'Devis expirés', status: null, derived: 'expired' },
    { value: 'unpaid', label: 'Reste à encaisser', status: null, derived: 'unpaid' },
    { value: 'overdue', label: 'En retard', status: null, derived: 'overdue' },
    { value: 'cancelled', label: 'Annulés', status: 'cancelled', derived: null }
];

const PAGE = 50;

export interface DocumentsPageProps {
    currency: string;
    onBack(): void;
    onOpen(id: number): void;
    onNew(): void;
}

export default function DocumentsPage({ currency, onBack, onOpen, onNew }: DocumentsPageProps) {
    const canWrite = useWorkspacePermissions().canFeature('invoicing', 'write');
    const [kind, setKind] = useState<'all' | DocumentKind>('all');
    const [state, setState] = useState('all');
    const [year, setYear] = useState('all');
    const [search, setSearch] = useState('');
    const [query, setQuery] = useState('');
    const [limit, setLimit] = useState(PAGE);

    // La recherche attend la fin de la frappe : une requête par touche ferait
    // clignoter la liste et charger le serveur pour rien.
    useEffect(() => {
        const timer = window.setTimeout(() => setQuery(search.trim()), 300);
        return () => window.clearTimeout(timer);
    }, [search]);

    const chosen = STATES.find((entry) => entry.value === state) ?? STATES[0];

    const load = useCallback(
        async () =>
            api.send('invoicing.docList', {
                kind: kind === 'all' ? null : kind,
                status: chosen.status,
                derived: chosen.derived,
                clientId: null,
                year: year === 'all' ? null : Number(year),
                search: query,
                limit,
                offset: 0
            }),
        [kind, chosen.status, chosen.derived, year, query, limit]
    );
    const { data, error, loading } = useResource('invoicing.docList', load, 'Chargement impossible.', [
        kind,
        state,
        year,
        query,
        limit
    ]);

    const years = useMemo(() => {
        const found = new Set<string>();
        for (const doc of data?.docs ?? []) if (doc.issuedOn !== null) found.add(doc.issuedOn.slice(0, 4));
        return [...found].sort().reverse();
    }, [data]);

    const docs = data?.docs ?? [];
    const filtered = kind !== 'all' || state !== 'all' || year !== 'all' || query.length > 0;

    return (
        <div className={styles.page}>
            <header className={styles.pageHead}>
                <Button variant='ghost' icon='arrow-left' onClick={onBack}>
                    Accueil
                </Button>
                <h2 className={styles.pageTitle}>Documents</h2>
                {canWrite && (
                    <Button icon='add' onClick={onNew}>
                        Document
                    </Button>
                )}
            </header>

            <div className={styles.filters}>
                <SegmentedControl
                    value={kind}
                    options={[
                        { value: 'all' as const, label: 'Tous' },
                        { value: 'quote' as const, label: 'Devis' },
                        { value: 'invoice' as const, label: 'Factures' },
                        { value: 'credit' as const, label: 'Avoirs' }
                    ]}
                    onChange={setKind}
                    aria-label='Type de document'
                />

                <div className={styles.filterState}>
                    <SelectInput value={state} aria-label='État' onChange={(e) => setState(e.target.value)}>
                        {STATES.map((entry) => (
                            <option key={entry.value} value={entry.value}>
                                {entry.label}
                            </option>
                        ))}
                    </SelectInput>
                </div>

                {years.length > 1 && (
                    <div className={styles.filterYear}>
                        <SelectInput value={year} aria-label='Année' onChange={(e) => setYear(e.target.value)}>
                            <option value='all'>Toutes</option>
                            {years.map((entry) => (
                                <option key={entry} value={entry}>
                                    {entry}
                                </option>
                            ))}
                        </SelectInput>
                    </div>
                )}

                <div className={styles.filterSearch}>
                    <TextInput
                        type='search'
                        value={search}
                        aria-label='Chercher un numéro'
                        placeholder='Numéro'
                        onChange={(e) => setSearch(e.target.value)}
                    />
                </div>
            </div>

            {error !== null && <p className={styles.error}>{error}</p>}

            {data !== null && (
                <p className={styles.paneCount}>
                    {data.totals.count} document{data.totals.count > 1 ? 's' : ''}
                    {data.totals.outstandingCents > 0 &&
                        ` · ${formatMoney(data.totals.outstandingCents, currency)} à encaisser`}
                    {data.totals.overdueCents > 0 && (
                        <span className={styles.countLate}>
                            {' '}
                            · {formatMoney(data.totals.overdueCents, currency)} en retard
                        </span>
                    )}
                </p>
            )}

            {loading && data === null && <p className={styles.placeholder}>Chargement…</p>}

            {data !== null && docs.length === 0 ? (
                <div className={styles.empty}>
                    <span className={`icon ${styles.emptyIcon} icon-invoicing`} />
                    <p className={styles.emptyTitle}>
                        {filtered ? 'Aucun document ne correspond' : 'Aucun document pour l’instant'}
                    </p>
                    <p className={styles.emptyBody}>
                        {filtered
                            ? 'Essayez un autre état, ou retirez le filtre d’année.'
                            : 'Un devis propose, une facture demande le paiement. Le devis devient une facture en un clic quand votre client l’accepte.'}
                    </p>
                    {canWrite && !filtered && <Button onClick={onNew}>Créer un devis</Button>}
                </div>
            ) : (
                <>
                    <ul className={styles.rows}>
                        {docs.map((doc) => (
                            <li key={doc.id}>
                                <DocumentRow doc={doc} currency={currency} onOpen={() => onOpen(doc.id)} />
                            </li>
                        ))}
                    </ul>
                    {data !== null && docs.length < data.totals.count && (
                        <div className={styles.moreRow}>
                            <Button variant='secondary' onClick={() => setLimit((current) => current + PAGE)}>
                                Voir les {Math.min(PAGE, data.totals.count - docs.length)} suivants
                            </Button>
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
