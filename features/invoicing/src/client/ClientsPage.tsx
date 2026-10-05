import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, SegmentedControl, TextInput, useResource, useWorkspacePermissions } from 'deveye-sdk-client';

import ClientRow from './ClientRow';
import { api } from './api';
import styles from './style.module.css';

/**
 * Le carnet complet. Le nom étant scellé, la recherche se fait ici, sur ce qui
 * est déjà chargé : le dire franchement vaut mieux que laisser croire à une
 * recherche serveur qui ne trouverait rien.
 */
export interface ClientsPageProps {
    currency: string;
    onBack(): void;
    onOpen(id: number): void;
    onNew(): void;
}

export default function ClientsPage({ currency, onBack, onOpen, onNew }: ClientsPageProps) {
    const canWrite = useWorkspacePermissions().canFeature('invoicing', 'write');
    const [scope, setScope] = useState<'active' | 'all'>('active');
    const [search, setSearch] = useState('');
    const [query, setQuery] = useState('');

    useEffect(() => {
        const timer = window.setTimeout(() => setQuery(search.trim().toLowerCase()), 200);
        return () => window.clearTimeout(timer);
    }, [search]);

    const load = useCallback(async () => (await api.send('invoicing.clientList', { archived: true })).clients, []);
    const { data, error, loading } = useResource('invoicing.clientList', load, 'Chargement impossible.');

    const shown = useMemo(() => {
        const all = data ?? [];
        const kept = scope === 'all' ? all : all.filter((client) => !client.archived);
        if (query.length === 0) return kept;
        return kept.filter((client) =>
            [client.name, client.city, client.email].some((part) => part.toLowerCase().includes(query))
        );
    }, [data, scope, query]);

    const asideCount = (data ?? []).filter((client) => client.archived).length;

    return (
        <div className={styles.page}>
            <header className={styles.pageHead}>
                <Button variant='ghost' icon='arrow-left' aria-label='Accueil' title='Accueil' onClick={onBack}>
                    <span className={styles.backLabel}>Accueil</span>
                </Button>
                <h2 className={styles.pageTitle}>Clients</h2>
                {canWrite && (
                    <Button icon='add' onClick={onNew}>
                        Client
                    </Button>
                )}
            </header>

            <div className={styles.filters}>
                <div className={styles.filterKind}>
                    <SegmentedControl
                        value={scope}
                        options={[
                            { value: 'active' as const, label: 'Actifs' },
                            { value: 'all' as const, label: `Tous${asideCount > 0 ? ` (${asideCount} de côté)` : ''}` }
                        ]}
                        onChange={setScope}
                        aria-label='Quels clients'
                        fullWidth
                    />
                </div>
                <div className={styles.filterSearch}>
                    <TextInput
                        type='search'
                        value={search}
                        aria-label='Chercher un client'
                        placeholder='Nom, ville, e-mail'
                        onChange={(e) => setSearch(e.target.value)}
                    />
                </div>
            </div>

            {error !== null && <p className={styles.error}>{error}</p>}
            {loading && data === null && <p className={styles.placeholder}>Chargement…</p>}

            {data !== null && shown.length === 0 ? (
                <div className={styles.empty}>
                    <span className={`icon ${styles.emptyIcon} icon-users`} />
                    <p className={styles.emptyTitle}>
                        {query.length > 0 ? 'Aucun client ne correspond' : 'Votre carnet de clients'}
                    </p>
                    <p className={styles.emptyBody}>
                        {query.length > 0
                            ? 'La recherche porte sur ce qui est chargé : nom, ville et adresse e-mail.'
                            : 'Un client saisi une fois sert à tous ses documents, et corriger son adresse la corrige partout.'}
                    </p>
                    {canWrite && query.length === 0 && <Button onClick={onNew}>Ajouter un client</Button>}
                </div>
            ) : (
                <>
                    <p className={styles.paneCount}>
                        {shown.length} client{shown.length > 1 ? 's' : ''}
                    </p>
                    <ul className={styles.rows}>
                        {shown.map((client) => (
                            <li key={client.id}>
                                <ClientRow client={client} currency={currency} onOpen={() => onOpen(client.id)} />
                            </li>
                        ))}
                    </ul>
                </>
            )}
        </div>
    );
}
