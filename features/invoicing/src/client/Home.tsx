import { useCallback, useState } from 'react';
import {
    Button,
    FeatureSettingsButton,
    SegmentedControl,
    StickyHeader,
    useResource,
    useWorkspacePermissions
} from 'deveye-sdk-client';

import { issuerGaps, listGaps } from '../contracts/issuer';
import type { InvoicingSettings } from '../contracts/domain';
import MonthBars from './Charts/MonthBars';
import ClientRow from './ClientRow';
import DocumentRow from './DocumentRow';
import QuotaNote from './QuotaNote';
import { api } from './api';
import { formatMoney } from './format';
import styles from './style.module.css';

/**
 * L'accueil de la feature, et tout s'y fait : les chiffres, ce qui presse, les
 * derniers documents, les derniers clients. Pas d'onglets : ce qu'on vient
 * chercher est là, et « voir tout » ouvre la liste complète quand il en faut
 * plus. Une seule lecture nourrit la page entière.
 */

export interface HomeProps {
    /** Les réglages de l'espace, pour dire ce qui manque au profil avant qu'un document bute dessus. */
    settings: InvoicingSettings;
    onOpenDocuments(): void;
    onOpenClients(): void;
    onOpenDocument(id: number): void;
    onOpenClient(id: number): void;
    onNewDocument(): void;
    onNewClient(): void;
}

const RANGES = [
    { value: 'month' as const, label: 'Ce mois' },
    { value: 'quarter' as const, label: 'Ce trimestre' },
    { value: 'year' as const, label: 'Cette année' }
];

const RECENT = 5;

export default function Home(props: HomeProps) {
    const canWrite = useWorkspacePermissions().canFeature('invoicing', 'write');
    const [range, setRange] = useState<'month' | 'quarter' | 'year'>('month');

    const load = useCallback(async () => api.send('invoicing.dashboard', { range, recent: RECENT }), [range]);
    const { data, error, loading } = useResource('invoicing.dashboard', load, 'Chargement impossible.', [range]);

    if (loading && data === null) return <p className={styles.placeholder}>Chargement…</p>;
    if (data === null) return <p className={styles.error}>{error ?? 'Chargement impossible.'}</p>;

    const board = data.dashboard;
    const currency = board.currency;
    const drift = board.cashedCents - board.cashedBeforeCents;
    const gaps = issuerGaps(props.settings.issuer);

    return (
        <div className={styles.home}>
            <StickyHeader>
                <header className={styles.header}>
                    <div>
                        <h2 className={styles.heading}>Facturation</h2>
                        <p className={styles.subheading}>
                            {board.outstandingCents > 0
                                ? `${formatMoney(board.outstandingCents, currency)} à encaisser`
                                : 'Rien à encaisser'}
                            {board.overdueCount > 0 && (
                                <span className={styles.countLate}>
                                    {' '}
                                    · {board.overdueCount} facture{board.overdueCount > 1 ? 's' : ''} en retard
                                </span>
                            )}
                            {board.quotesPendingCount > 0 && ` · ${board.quotesPendingCount} devis en attente`}
                        </p>
                    </div>
                    <div className={styles.actions}>
                        <FeatureSettingsButton scope={{ kind: 'feature', feature: 'invoicing' }} />
                        {canWrite && (
                            <Button icon='add' onClick={props.onNewDocument}>
                                Document
                            </Button>
                        )}
                    </div>
                </header>
            </StickyHeader>

            {gaps.length > 0 && (
                <div className={styles.banner} role='status'>
                    <span className='icon icon-info' aria-hidden='true' />
                    <p className={styles.bannerText}>
                        <strong>Votre profil d’émetteur est incomplet.</strong> Il manque {listGaps(gaps)} : ce sont des
                        mentions obligatoires, aucun document ne peut être émis sans elles.
                    </p>
                    <FeatureSettingsButton
                        scope={{ kind: 'feature', feature: 'invoicing' }}
                        initialSection='general'
                        label='Compléter'
                        variant='primary'
                    />
                </div>
            )}

            <div className={styles.periodRow}>
                <SegmentedControl value={range} options={RANGES} onChange={setRange} aria-label='Période' />
            </div>

            <dl className={styles.figures}>
                <div className={styles.figure}>
                    <dt>Encaissé</dt>
                    <dd>{formatMoney(board.cashedCents, currency)}</dd>
                    <p className={styles.figureNote}>
                        {board.cashedBeforeCents === 0
                            ? 'Rien sur la période précédente'
                            : `${drift >= 0 ? '+' : '−'} ${formatMoney(Math.abs(drift), currency)} sur la précédente`}
                    </p>
                </div>

                <div className={styles.figure}>
                    <dt>À encaisser</dt>
                    <dd>{formatMoney(board.outstandingCents, currency)}</dd>
                    <p className={styles.figureNote}>
                        {board.billedCount === 0
                            ? 'Aucune facture sur la période'
                            : `${board.billedCount} facture${board.billedCount > 1 ? 's' : ''} émise${board.billedCount > 1 ? 's' : ''}, ${formatMoney(board.billedCents, currency)}`}
                    </p>
                </div>

                <div className={`${styles.figure} ${board.overdueCents > 0 ? styles.figureBad : ''}`}>
                    <dt>En retard</dt>
                    <dd>{formatMoney(board.overdueCents, currency)}</dd>
                    <p className={styles.figureNote}>
                        {board.overdueCount === 0
                            ? 'Rien ne traîne'
                            : `${board.overdueCount} facture${board.overdueCount > 1 ? 's' : ''} échue${board.overdueCount > 1 ? 's' : ''}`}
                    </p>
                </div>

                <div className={styles.figure}>
                    <dt>Devis en attente</dt>
                    <dd>{formatMoney(board.quotesPendingCents, currency)}</dd>
                    <p className={styles.figureNote}>
                        {board.quotesPendingCount === 0
                            ? 'Aucun devis en cours'
                            : board.quotesExpiringSoon > 0
                              ? `${board.quotesExpiringSoon} expire${board.quotesExpiringSoon > 1 ? 'nt' : ''} sous huit jours`
                              : `${board.quotesPendingCount} devis en cours`}
                    </p>
                </div>

                {board.vatRegime === 'standard' && (
                    <div className={styles.figure}>
                        <dt>TVA collectée</dt>
                        <dd>{formatMoney(board.vatCollectedCents, currency)}</dd>
                        <p className={styles.figureNote}>
                            Sur ce qui a été encaissé : c’est l’encaissement qui rend la taxe due, pas la facturation.
                        </p>
                    </div>
                )}
            </dl>

            <QuotaNote usage={board.usage} />

            {data.actionable.length > 0 && (
                <Section title='À traiter' hint='Le plus ancien d’abord.'>
                    <ul className={styles.rows}>
                        {data.actionable.map((doc) => (
                            <li key={doc.id}>
                                <DocumentRow
                                    doc={doc}
                                    currency={currency}
                                    amount='remaining'
                                    onOpen={() => props.onOpenDocument(doc.id)}
                                />
                            </li>
                        ))}
                    </ul>
                </Section>
            )}

            <Section
                title='Documents'
                actions={
                    <button type='button' className={styles.seeAll} onClick={props.onOpenDocuments}>
                        Voir tout
                    </button>
                }
            >
                {data.recentDocs.length === 0 ? (
                    <EmptyLine
                        icon='invoicing'
                        title='Votre premier devis'
                        body='Une liste de prestations avec un total, valable un temps donné. Il devient une facture en un clic quand votre client l’accepte.'
                        action={canWrite ? <Button onClick={props.onNewDocument}>Créer un devis</Button> : undefined}
                    />
                ) : (
                    <ul className={styles.rows}>
                        {data.recentDocs.map((doc) => (
                            <li key={doc.id}>
                                <DocumentRow
                                    doc={doc}
                                    currency={currency}
                                    onOpen={() => props.onOpenDocument(doc.id)}
                                />
                            </li>
                        ))}
                    </ul>
                )}
            </Section>

            <Section
                title='Clients'
                actions={
                    <>
                        {canWrite && (
                            <button type='button' className={styles.seeAll} onClick={props.onNewClient}>
                                Nouveau client
                            </button>
                        )}
                        <button type='button' className={styles.seeAll} onClick={props.onOpenClients}>
                            Voir tout
                        </button>
                    </>
                }
            >
                {data.recentClients.length === 0 ? (
                    <EmptyLine
                        icon='users'
                        title='Votre carnet de clients'
                        body='Un client saisi une fois sert à tous ses documents, et corriger son adresse la corrige partout.'
                        action={canWrite ? <Button onClick={props.onNewClient}>Ajouter un client</Button> : undefined}
                    />
                ) : (
                    <ul className={styles.rows}>
                        {data.recentClients.map((client) => (
                            <li key={client.id}>
                                <ClientRow
                                    client={client}
                                    currency={currency}
                                    onOpen={() => props.onOpenClient(client.id)}
                                />
                            </li>
                        ))}
                    </ul>
                )}
            </Section>

            {board.months.length > 1 && (
                <Section title='Sur un an'>
                    <MonthBars months={board.months} currency={currency} />
                </Section>
            )}

            {!canWrite && (
                <p className={styles.placeholder}>
                    Votre rôle permet de lire les documents de cet espace, pas de les modifier.
                </p>
            )}
        </div>
    );
}

function Section({
    title,
    hint,
    actions,
    children
}: {
    title: string;
    hint?: string;
    actions?: React.ReactNode;
    children: React.ReactNode;
}) {
    return (
        <section className={styles.section}>
            <header className={styles.sectionHead}>
                <h3 className={styles.sectionTitle}>{title}</h3>
                {hint !== undefined && <span className={styles.sectionHint}>{hint}</span>}
                {actions !== undefined && <div className={styles.sectionActions}>{actions}</div>}
            </header>
            {children}
        </section>
    );
}

function EmptyLine({
    icon,
    title,
    body,
    action
}: {
    icon: string;
    title: string;
    body: string;
    action?: React.ReactNode;
}) {
    return (
        <div className={styles.empty}>
            <span className={`icon ${styles.emptyIcon} icon-${icon}`} />
            <p className={styles.emptyTitle}>{title}</p>
            <p className={styles.emptyBody}>{body}</p>
            {action}
        </div>
    );
}
