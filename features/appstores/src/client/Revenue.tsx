import { ErrorNote, useResource } from 'deveye-sdk-client';
import type { AppStore, AppStoresApp, AppStoresRange, AppStoresSource } from '../contracts/domain';

import { api } from './api';
import CapabilityNote from './CapabilityNote';
import {
    absentValue,
    bucketStarts,
    currencyName,
    formatDay,
    formatMoney,
    ON_STORE,
    plural,
    STORE_ICONS,
    STORE_LABELS,
    STORE_ORDER
} from './format';
import StatBand, { relativeChange } from './Stats/StatBand';
import TrendChart from './Stats/TrendChart';
import styles from './style.module.css';

/** Ce que chaque store compte : Apple après sa commission, Google avant la sienne. */
const MEANING: Record<AppStore, string> = {
    apple: 'Produits nets',
    google: 'Ventes estimées, avant la commission de Google'
};

interface RevenueProps {
    app: AppStoresApp;
    sources: readonly AppStoresSource[] | null;
    /** La période, commune aux onglets de la fiche. */
    range: AppStoresRange;
    /** Le store choisi dans la fiche, `null` pour les deux. */
    store: AppStore | null;
}

/**
 * Ce que rapporte une app, par store et par devise : rien ne se somme d'un
 * store à l'autre ni d'une devise à l'autre. Monté seulement pour qui tient le
 * droit Revenus sur cette app ; le serveur le vérifie de son côté.
 */
export function Revenue({ app, store, sources, range }: RevenueProps) {
    const stores = STORE_ORDER.filter((store) => app.listings.some((listing) => listing.store === store));
    const linked = stores.length > 0;

    const { data: revenue, error } = useResource(
        'appstores.revenue',
        () =>
            linked
                ? api
                      .send('appstores.revenue', { appId: app.id, range, ...(store ? { store } : {}) })
                      .then((res) => res.revenue)
                : Promise.resolve(null),
        'Les revenus de cette app n’ont pas pu être lus.',
        [app.id, range, store, linked]
    );

    if (!linked) {
        return (
            <p className={styles.blockEmpty}>
                Cette app n’est reliée à aucun store : ses ventes arriveront dès qu’une fiche sera reliée.
            </p>
        );
    }

    const empty = revenue ? stores.filter((store) => !revenue.totals.some((total) => total.store === store)) : [];

    return (
        <section className={styles.block}>
            <header className={styles.blockHead}>
                <p className={styles.until}>
                    {revenue?.dataUntil ? `Données jusqu’au ${formatDay(revenue.dataUntil)}` : ''}
                </p>
            </header>
            <p className={styles.blockHint}>
                Apple donne ce qui vous revient après sa commission, Google ce que paient vos clients avant la sienne :
                les deux ne s’additionnent pas, et chaque devise reste à part.
            </p>
            <ErrorNote note={error} />
            <CapabilityNote app={app} sources={sources} capabilities={['revenue']} empty={empty} />

            {revenue === null ? (
                !error && <p className={styles.blockEmpty}>Chargement…</p>
            ) : (
                <div className={styles.measure} data-stale={revenue.range !== range ? '' : undefined}>
                    {stores.map((store) => {
                        // La devise qui pèse le plus en ventes : les montants de deux devises ne se comparent pas.
                        const totals = revenue.totals
                            .filter((total) => total.store === store)
                            .sort((a, b) => b.units - a.units || b.amount - a.amount);
                        const main = totals[0]?.currency ?? null;
                        const slots = bucketStarts(
                            revenue.from,
                            revenue.to,
                            revenue.bucket,
                            revenue.points.map((point) => point.at)
                        );
                        const byAt = new Map(
                            revenue.points
                                .filter((point) => point.store === store && point.currency === main)
                                .map((point) => [point.at, point.amount])
                        );
                        return (
                            <div key={store} className={styles.storeRevenue}>
                                <h3 className={styles.blockTitle}>
                                    <span className={`icon icon-${STORE_ICONS[store]}`} aria-hidden='true' />
                                    {STORE_LABELS[store]}
                                    <span className={styles.blockTitleNote}>{MEANING[store]}</span>
                                </h3>
                                {totals.length === 0 ? (
                                    <p className={styles.blockEmpty}>Aucune vente relevée sur la période.</p>
                                ) : (
                                    <>
                                        <StatBand
                                            tiles={totals.map((total) => ({
                                                key: total.currency,
                                                label: currencyName(total.currency),
                                                value: formatMoney(total.amount, total.currency),
                                                hint: `${MEANING[store]}, en ${currencyName(total.currency).toLowerCase()}.`,
                                                change: revenue.previousCovered
                                                    ? relativeChange(total.amount, total.previous)
                                                    : null,
                                                note: plural(total.units, 'vente', 'ventes')
                                            }))}
                                        />
                                        {main !== null && (
                                            <TrendChart
                                                title={`${MEANING[store]}, en ${currencyName(main).toLowerCase()}`}
                                                slots={slots}
                                                resolution={revenue.resolution}
                                                series={[
                                                    {
                                                        key: store,
                                                        label: STORE_LABELS[store],
                                                        values: slots.map(
                                                            (at) => byAt.get(at) ?? absentValue(at, revenue.dataUntil)
                                                        ),
                                                        summary: `${formatMoney(totals[0].amount, main)} sur la période`
                                                    }
                                                ]}
                                                format={(value) => formatMoney(value, main)}
                                                label={`${MEANING[store]} ${ON_STORE[store]} : ${formatMoney(totals[0].amount, main)} sur la période.`}
                                            />
                                        )}
                                    </>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </section>
    );
}

export default Revenue;
