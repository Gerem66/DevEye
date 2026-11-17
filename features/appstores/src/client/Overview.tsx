import { ErrorNote, FeatureSettingsButton, StatusBadge, useResource } from 'deveye-sdk-client';
import {
    APPSTORES_CRASH_THRESHOLD,
    type AppStore,
    type AppStoresApp,
    type AppStoresRange,
    type AppStoresSource
} from '../contracts/domain';

import { api } from './api';
import CapabilityNote from './CapabilityNote';
import {
    countryName,
    formatCount,
    formatDate,
    formatDay,
    formatRate,
    formatRating,
    MISSING,
    ON_STORE,
    plural,
    STORE_LABELS,
    STORE_ORDER,
    storePageUrl,
    versionStates
} from './format';
import CountriesPanel from './Stats/CountriesPanel';
import { downloadSeries, downloadsOf } from './Stats/downloads';
import StatBand, { ratingChange, relativeChange, type StatTile } from './Stats/StatBand';
import TrendChart, { type TrendSeries } from './Stats/TrendChart';
import styles from './style.module.css';

interface OverviewProps {
    app: AppStoresApp;
    sources: readonly AppStoresSource[] | null;
    /** La période, commune aux onglets de la fiche. */
    range: AppStoresRange;
    /** Le store choisi dans la fiche, `null` pour les deux. */
    store: AppStore | null;
    canWrite: boolean;
}

const countOrMissing = (value: number | null) => (value === null ? MISSING : formatCount(value));

/**
 * L'aperçu d'une app : les chiffres de la période et leur écart à la
 * précédente, la courbe des téléchargements par store, leurs pays, puis les
 * versions de chaque store. Aucun montant ici : les revenus ont leur onglet
 * et leur droit.
 */
export function Overview({ app, store, sources, canWrite, range }: OverviewProps) {
    const has = (store: AppStore) => app.listings.some((listing) => listing.store === store);
    const linked = app.listings.length > 0;

    const { data: stats, error } = useResource(
        'appstores.stats',
        () =>
            linked
                ? api
                      .send('appstores.stats', { appId: app.id, range, ...(store ? { store } : {}) })
                      .then((res) => res.stats)
                : Promise.resolve(null),
        'Les chiffres de cette app n’ont pas pu être lus.',
        [app.id, range, store, linked]
    );

    const settings = {
        kind: 'item' as const,
        feature: 'appstores' as const,
        itemId: String(app.id),
        itemLabel: app.name
    };
    const canSet = canWrite && !app.foreign;

    if (!linked) {
        return (
            <div className={styles.emptyCard}>
                <span className={`icon icon-appstores ${styles.emptyIcon}`} aria-hidden='true' />
                <div className={styles.emptyText}>
                    <p className={styles.emptyTitle}>Reliée à aucun store</p>
                    <p>
                        Dès sa sortie, reliez sa fiche App Store ou Google Play : ses téléchargements, ses notes et ses
                        avis arriveront seuls.
                    </p>
                </div>
                {canSet && (
                    <FeatureSettingsButton
                        scope={settings}
                        initialSection='general'
                        variant='primary'
                        label='Relier un store'
                    />
                )}
            </div>
        );
    }

    const apple = app.listings.find((listing) => listing.store === 'apple') ?? null;
    const google = app.listings.find((listing) => listing.store === 'google') ?? null;

    const stores = STORE_ORDER.filter(has);

    const tiles: StatTile[] = [];
    let series: TrendSeries[] = [];
    let slots: number[] = [];
    if (stats) {
        const covered = stats.previousCovered;
        const { metrics, previous } = stats;
        tiles.push({
            key: 'downloads',
            label: 'Téléchargements',
            value: countOrMissing(downloadsOf(metrics, stores)),
            hint: 'Les premières installations de l’app sur la période. Les mises à jour ne comptent pas.',
            change: covered ? relativeChange(downloadsOf(metrics, stores), downloadsOf(previous, stores)) : null,
            note:
                apple && google
                    ? `App Store ${countOrMissing(metrics.downloads.apple)} · Google Play ${countOrMissing(metrics.downloads.google)}`
                    : undefined
        });
        if (apple) {
            tiles.push({
                key: 'ratingApple',
                label: 'Note App Store',
                value: metrics.rating.apple === null ? MISSING : formatRating(metrics.rating.apple),
                hint: 'La note moyenne affichée sur l’App Store de ce pays : Apple ne publie pas de note mondiale.',
                change: covered ? ratingChange(metrics.rating.apple, previous.rating.apple) : null,
                note: [
                    apple.ratingCount === null ? null : plural(apple.ratingCount, 'note', 'notes'),
                    countryName(app.ratingCountry)
                ]
                    .filter((part): part is string => part !== null)
                    .join(' · ')
            });
        }
        if (google) {
            tiles.push({
                key: 'ratingGoogle',
                label: 'Note Google Play',
                value: metrics.rating.google === null ? MISSING : formatRating(metrics.rating.google),
                hint: 'La note moyenne affichée sur Google Play, tous pays confondus.',
                change: covered ? ratingChange(metrics.rating.google, previous.rating.google) : null,
                note: google.ratingCount === null ? undefined : plural(google.ratingCount, 'note', 'notes')
            });
        }
        tiles.push({
            key: 'reviews',
            label: 'Avis reçus',
            value: formatCount(metrics.reviews),
            hint: 'Les avis écrits reçus sur la période, tous stores confondus.',
            change: covered ? relativeChange(metrics.reviews, previous.reviews) : null
        });
        if (google) {
            tiles.push({
                key: 'crash',
                label: 'Taux de plantage',
                value: metrics.crashRate === null ? MISSING : formatRate(metrics.crashRate),
                hint:
                    'La part des utilisateurs Android qui ont vu l’app planter, telle que Google la mesure. ' +
                    'Une baisse est une bonne nouvelle.',
                change: covered ? relativeChange(metrics.crashRate, previous.crashRate, true) : null,
                note: `seuil de Google : ${formatRate(APPSTORES_CRASH_THRESHOLD)}`
            });
        }

        ({ slots, series } = downloadSeries(stats, stores));
    }

    const empty = stats
        ? STORE_ORDER.filter(
              (store) => has(store) && stats.metrics.downloads[store] === null && stats.metrics.rating[store] === null
          )
        : [];

    return (
        <>
            {app.listings.map((listing) =>
                listing.sourceId === null ? (
                    <p key={listing.store} className={styles.notice}>
                        {STORE_LABELS[listing.store]} : aucun compte de store n’est choisi, cette fiche ne se
                        synchronise pas.{' '}
                        {canSet && (
                            <FeatureSettingsButton
                                scope={settings}
                                initialSection='general'
                                variant='link'
                                label='Choisir un compte'
                            />
                        )}
                    </p>
                ) : listing.syncError ? (
                    <p key={listing.store} className={styles.noticeDanger}>
                        {STORE_LABELS[listing.store]} : {listing.syncError}
                    </p>
                ) : null
            )}

            <section className={styles.block}>
                <header className={styles.blockHead}>
                    <p className={styles.until}>
                        {stats === null
                            ? ''
                            : stats.dataUntil === null
                              ? 'Aucun chiffre relevé pour l’instant'
                              : `Données jusqu’au ${formatDay(stats.dataUntil)}`}
                    </p>
                </header>

                <ErrorNote note={error} />
                <CapabilityNote
                    app={app}
                    sources={sources}
                    capabilities={['downloads', 'ratings', 'versions', 'vitals']}
                    empty={empty}
                />

                {stats === null ? (
                    !error && <p className={styles.blockEmpty}>Chargement…</p>
                ) : (
                    // Une autre période en route : l'ancienne reste lisible, atténuée, jusqu'à son remplacement.
                    <div className={styles.measure} data-stale={stats.range !== range ? '' : undefined}>
                        <StatBand tiles={tiles} />
                        {stats.dataUntil === null ? (
                            <p className={styles.blockEmpty}>
                                Le premier passage relit jusqu’à un an d’historique, puis Apple et Google publient leurs
                                chiffres avec un ou deux jours de retard. Ils apparaîtront ici d’eux-mêmes.
                            </p>
                        ) : (
                            <TrendChart
                                title='Téléchargements'
                                slots={slots}
                                resolution={stats.resolution}
                                series={series}
                                format={formatCount}
                                axis
                                label={`Téléchargements par ${stats.resolution === 'week' ? 'semaine' : 'jour'} sur la période : ${countOrMissing(downloadsOf(stats.metrics, stores))} au total.`}
                            />
                        )}
                    </div>
                )}
            </section>

            {stats !== null && stats.dataUntil !== null && (
                <CountriesPanel countries={stats.countries} stale={stats.range !== range} />
            )}

            {(google || apple) && (
                // Google Play à gauche, l'App Store à droite ; l'un sous l'autre à l'étroit.
                <div className={styles.versionPanels}>
                    {[google, apple].map(
                        (listing) =>
                            listing && (
                                <section key={listing.store} className={`${styles.block} ${styles.versionsBlock}`}>
                                    <header className={styles.blockHead}>
                                        <h3 className={styles.blockTitle}>Versions {ON_STORE[listing.store]}</h3>
                                    </header>
                                    {listing.versions.length === 0 ? (
                                        <p className={styles.blockEmpty}>Aucune version relevée pour l’instant.</p>
                                    ) : (
                                        <ul className={styles.versionList}>
                                            {versionStates(listing.versions).map((state, index) => {
                                                const version = listing.versions[index];
                                                return (
                                                    <li key={`${version.version}-${index}`}>
                                                        <a
                                                            className={styles.versionRow}
                                                            href={storePageUrl(listing.store, listing.externalId)}
                                                            target='_blank'
                                                            rel='noopener noreferrer'
                                                            title={`Ouvrir la fiche de l’app ${ON_STORE[listing.store]}`}
                                                        >
                                                            <span className={styles.versionName}>
                                                                {version.version}
                                                            </span>
                                                            <StatusBadge tone={state.tone}>{state.label}</StatusBadge>
                                                            {version.since !== null && (
                                                                <span className={styles.versionSince}>
                                                                    depuis le {formatDate(version.since)}
                                                                </span>
                                                            )}
                                                            <span
                                                                className={`icon icon-move-to-right ${styles.versionOpen}`}
                                                                aria-hidden='true'
                                                            />
                                                        </a>
                                                    </li>
                                                );
                                            })}
                                        </ul>
                                    )}
                                </section>
                            )
                    )}
                </div>
            )}
        </>
    );
}

export default Overview;
