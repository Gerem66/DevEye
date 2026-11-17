import { useState } from 'react';
import {
    Button,
    ErrorNote,
    invalidate,
    SegmentedControl,
    StatusBadge,
    StickyHeader,
    useResource,
    useSubView
} from 'deveye-sdk-client';
import {
    APPSTORES_ANR_THRESHOLD,
    APPSTORES_CRASH_THRESHOLD,
    type AppStore,
    type AppStoresReview
} from '../contracts/domain';

import { api } from './api';
import { formatCount, formatDay, formatRate, MISSING, plural, STORE_LABELS } from './format';
import ReplyDialog from './ReplyDialog';
import { REVENUE_HINT, RevenueTotals, storeTotals } from './Revenue';
import { ReviewCard } from './Reviews';
import CountriesPanel from './Stats/CountriesPanel';
import { setStoresPrefs, useStoresPrefs } from './prefs';
import CurveViewBar from './Stats/CurveViewBar';
import { downloadCurves, downloadsOf } from './Stats/downloads';
import RangeBar from './Stats/RangeBar';
import RankBars from './Stats/RankBars';
import StatBand, { relativeChange } from './Stats/StatBand';
import TrendChart from './Stats/TrendChart';
import styles from './style.module.css';

interface StoresOverviewProps {
    /** Les stores où au moins une app est reliée, dans l'ordre d'affichage. */
    stores: readonly AppStore[];
    canWrite: boolean;
    onOpen: (appId: number) => void;
    onBack: () => void;
}

const countOrMissing = (value: number | null) => (value === null ? MISSING : formatCount(value));

/**
 * Toutes les apps à la fois, en page comme la fiche d'une app : ce qui se
 * cumule (téléchargements, pays, avis, revenus), et ce qui demande d'agir (avis
 * sans réponse, apps au-dessus d'un seuil de Google). Une note ne se cumule
 * pas : elle reste sur chaque app.
 */
export function StoresOverview({ stores, canWrite, onOpen, onBack }: StoresOverviewProps) {
    const [replying, setReplying] = useState<AppStoresReview | null>(null);
    const { range, store: chosenStore, curveView: view } = useStoresPrefs('overview');
    const store = chosenStore === 'all' || !stores.includes(chosenStore) ? null : chosenStore;
    useSubView('overview');

    const { data: overview, error } = useResource(
        'appstores.stats',
        () => api.send('appstores.overview', { range, ...(store ? { store } : {}) }).then((res) => res.overview),
        'La vue d’ensemble n’a pas pu être lue.',
        [range, store]
    );

    const head = (
        <StickyHeader className={styles.sheetSticky}>
            <header className={`${styles.header} ${styles.sheetHeader}`}>
                <div className={styles.detailHead}>
                    <Button
                        variant='ghost'
                        icon='arrow-left'
                        className={styles.back}
                        aria-label='Stores'
                        title='Stores'
                        onClick={onBack}
                    >
                        <span className={styles.backLabel}>Stores</span>
                    </Button>
                    <div className={styles.ident}>
                        <h2 className={styles.heading}>
                            <span className={styles.headingText}>Vue d’ensemble</span>
                        </h2>
                        <p className={styles.subheading}>
                            {overview ? `${plural(overview.apps.length, 'app comptée', 'apps comptées')}` : ''}
                        </p>
                    </div>
                </div>
            </header>
            <div className={styles.pageTools}>
                {stores.length > 1 && (
                    <SegmentedControl
                        value={store ?? 'all'}
                        options={[
                            { value: 'all', label: 'Tous' },
                            ...stores.map((entry) => ({ value: entry, label: STORE_LABELS[entry] }))
                        ]}
                        onChange={(next) => setStoresPrefs('overview', { store: next })}
                        aria-label='Store'
                    />
                )}
                <RangeBar value={range} onChange={(next) => setStoresPrefs('overview', { range: next })} />
            </div>
        </StickyHeader>
    );

    if (overview === null) {
        return (
            <div className={styles.root}>
                {head}
                {error ? <ErrorNote note={error} /> : <p className={styles.blockEmpty}>Chargement…</p>}
            </div>
        );
    }

    const shown = store ? [store] : stores;
    const covered = overview.previousCovered;
    const { slots, series } = downloadCurves(overview, shown, view, overview.apps);
    const stale = overview.range !== range ? '' : undefined;
    const ranked = overview.apps.filter((app) => app.downloads !== null && app.downloads > 0);

    return (
        <div className={styles.root}>
            {head}
            <ErrorNote note={error} />
            {overview.left.length > 0 && (
                <p className={styles.notice}>
                    Laissées de côté, leurs chiffres s’étant arrêtés bien avant ceux des autres :{' '}
                    {overview.left
                        .map(
                            (entry) => `${entry.name} (${STORE_LABELS[entry.store]}, au ${formatDay(entry.dataUntil)})`
                        )
                        .join(', ')}
                    .
                </p>
            )}

            <section className={styles.block}>
                <header className={styles.blockHead}>
                    <p className={styles.until}>
                        {overview.dataUntil === null
                            ? 'Aucun chiffre relevé pour l’instant'
                            : `Données jusqu’au ${formatDay(overview.dataUntil)}`}
                    </p>
                </header>
                <div className={styles.measure} data-stale={stale}>
                    <StatBand
                        tiles={[
                            {
                                key: 'downloads',
                                label: 'Téléchargements',
                                value: countOrMissing(downloadsOf(overview.metrics, shown)),
                                hint: 'Les premières installations de toutes les apps sur la période. Les mises à jour ne comptent pas.',
                                change: covered
                                    ? relativeChange(
                                          downloadsOf(overview.metrics, shown),
                                          downloadsOf(overview.previous, shown)
                                      )
                                    : null,
                                note:
                                    shown.length > 1
                                        ? shown
                                              .map(
                                                  (entry) =>
                                                      `${STORE_LABELS[entry]} ${countOrMissing(overview.metrics.downloads[entry])}`
                                              )
                                              .join(' · ')
                                        : undefined
                            },
                            {
                                key: 'reviews',
                                label: 'Avis reçus',
                                value: formatCount(overview.metrics.reviews),
                                hint: 'Les avis écrits reçus sur la période, toutes apps confondues.',
                                change: covered
                                    ? relativeChange(overview.metrics.reviews, overview.previous.reviews)
                                    : null
                            },
                            {
                                key: 'unanswered',
                                label: 'Sans réponse',
                                value: formatCount(overview.unanswered),
                                hint: 'Les avis de la période qui attendent encore une réponse.'
                            }
                        ]}
                    />
                    {overview.dataUntil !== null && (
                        <TrendChart
                            title='Téléchargements'
                            tools={<CurveViewBar scope='overview' stores={shown} />}
                            slots={slots}
                            resolution={overview.resolution}
                            series={series}
                            format={formatCount}
                            axis
                            label={`Téléchargements de toutes les apps par ${overview.resolution === 'week' ? 'semaine' : 'jour'} : ${countOrMissing(downloadsOf(overview.metrics, shown))} au total.`}
                        />
                    )}
                </div>
            </section>

            {ranked.length > 0 && (
                <section className={styles.block}>
                    <header className={styles.blockHead}>
                        <h3 className={styles.blockTitle}>Téléchargements par app</h3>
                    </header>
                    <div className={styles.measure} data-stale={stale}>
                        <RankBars
                            items={ranked.map((app) => ({
                                key: String(app.id),
                                label: app.name,
                                downloads: app.downloads ?? 0
                            }))}
                            noun='apps'
                            onPick={(key) => onOpen(Number(key))}
                        />
                    </div>
                </section>
            )}

            {overview.dataUntil !== null && (
                <CountriesPanel countries={overview.countries} stale={stale !== undefined} />
            )}

            <section className={styles.block}>
                <header className={styles.blockHead}>
                    <h3 className={styles.blockTitle}>
                        Avis sans réponse
                        {overview.unanswered > overview.reviews.length && (
                            <span className={styles.blockTitleNote}>
                                les {overview.reviews.length} plus mal notés sur {formatCount(overview.unanswered)}
                            </span>
                        )}
                    </h3>
                </header>
                {overview.reviews.length === 0 ? (
                    <p className={styles.blockEmpty}>Aucun avis n’attend de réponse sur la période.</p>
                ) : (
                    <ul className={styles.reviewList} data-stale={stale}>
                        {overview.reviews.map((review) => (
                            <ReviewCard
                                key={review.id}
                                review={review}
                                appName={review.app.name}
                                replyBlocked={canWrite && review.replyable ? '' : null}
                                onReply={() => setReplying(review)}
                            />
                        ))}
                    </ul>
                )}
            </section>

            {overview.alerts.length > 0 && (
                <section className={styles.block}>
                    <header className={styles.blockHead}>
                        <h3 className={styles.blockTitle}>Au-dessus des seuils de Google</h3>
                    </header>
                    <ul className={styles.alertList}>
                        {overview.alerts.map((alert) => (
                            <li key={alert.id}>
                                <button type='button' className={styles.alertRow} onClick={() => onOpen(alert.id)}>
                                    <span className={styles.alertName}>{alert.name}</span>
                                    {alert.crashRate !== null && alert.crashRate > APPSTORES_CRASH_THRESHOLD && (
                                        <StatusBadge tone='danger'>Plantages {formatRate(alert.crashRate)}</StatusBadge>
                                    )}
                                    {alert.anrRate !== null && alert.anrRate > APPSTORES_ANR_THRESHOLD && (
                                        <StatusBadge tone='danger'>Blocages {formatRate(alert.anrRate)}</StatusBadge>
                                    )}
                                </button>
                            </li>
                        ))}
                    </ul>
                    <p className={styles.blockHint}>
                        Sur les 28 derniers jours mesurés par Google : au-delà de{' '}
                        {formatRate(APPSTORES_CRASH_THRESHOLD)} de plantages ou de {formatRate(APPSTORES_ANR_THRESHOLD)}{' '}
                        de blocages, Google Play peut moins bien la montrer.
                    </p>
                </section>
            )}

            {overview.revenue && (
                <section className={styles.block}>
                    <header className={styles.blockHead}>
                        <h3 className={styles.blockTitle}>Revenus</h3>
                    </header>
                    <p className={styles.blockHint}>
                        {REVENUE_HINT}
                        {overview.revenue.partial &&
                            ' Les apps dont votre rôle ne voit pas les revenus n’y sont pas comptées.'}
                    </p>
                    <div className={styles.measure} data-stale={stale}>
                        {shown.map((entry) => (
                            <div key={entry} className={styles.storeRevenue}>
                                <RevenueTotals
                                    store={entry}
                                    totals={storeTotals(overview.revenue?.totals ?? [], entry)}
                                    covered={covered}
                                />
                            </div>
                        ))}
                    </div>
                </section>
            )}

            <ReplyDialog
                review={replying}
                onClose={() => setReplying(null)}
                onReplied={() => {
                    setReplying(null);
                    invalidate('appstores.reviews', 'appstores.stats');
                }}
            />
        </div>
    );
}

export default StoresOverview;
