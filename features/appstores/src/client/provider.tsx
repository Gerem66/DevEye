import type { ReactNode } from 'react';
import {
    Button,
    ErrorNote,
    FeatureSettingsButton,
    openFeature,
    PlanPausedBadge,
    StatusBadge,
    useResource
} from 'deveye-sdk-client';
import type { AppStoresClientProvider, SdkTileMetric, SdkTileSummary } from '@deveye/types/sdk/client';
import type { AppStoresAppSummary, AppStoresRange } from '../contracts/domain';

import { api } from './api';
import AppDialog from './AppDialog';
import { formatCount, formatRating, MISSING, ON_STORE, plural, STORE_LABELS, STORE_ORDER } from './format';
import { downloadSeries, downloadsOf } from './Stats/downloads';
import StatBand, { ratingChange, relativeChange, type StatTile } from './Stats/StatBand';
import TrendChart from './Stats/TrendChart';
import StoreChips from './StoreChips';
import styles from './style.module.css';

/**
 * Ce que le module offre à l'onglet Stores d'un projet : la liste des apps de
 * l'espace, une app reliée en aperçu compact, et le dialogue d'ajout. Aucun
 * montant ici : les revenus ont leur droit, que l'onglet d'un projet n'ouvre pas.
 */

const LINKED_RANGE: AppStoresRange = '30d';

function LinkedApp({ appId, canWrite, onUnlink }: { appId: number; canWrite: boolean; onUnlink: () => void }) {
    const detail = useResource(
        'appstores.detail',
        () => api.send('appstores.get', { appId }),
        'Cette app n’a pas pu être lue.',
        [appId]
    );
    const linked = (detail.data?.app.listings.length ?? 0) > 0;
    const stats = useResource(
        'appstores.stats',
        () =>
            linked
                ? api.send('appstores.stats', { appId, range: LINKED_RANGE }).then((res) => res.stats)
                : Promise.resolve(null),
        'Ses chiffres n’ont pas pu être lus.',
        [appId, linked]
    );

    if (detail.data === null) {
        if (detail.error === null) return <p className={styles.empty}>Chargement…</p>;
        return (
            <section className={styles.linked} aria-label='App indisponible'>
                <div className={styles.linkedHead}>
                    <p className={styles.blockEmpty}>
                        {detail.error.code === 'not_found' || detail.error.code === 'forbidden'
                            ? 'Cette app n’est plus visible dans cet espace.'
                            : detail.error.message}
                    </p>
                    {canWrite && (
                        <Button variant='ghost' onClick={onUnlink}>
                            Délier
                        </Button>
                    )}
                </div>
            </section>
        );
    }

    const { app } = detail.data;
    const tiles: StatTile[] = [];
    let chart: ReactNode = null;
    if (stats.data) {
        const { metrics, previous, previousCovered } = stats.data;
        const stores = STORE_ORDER.filter((store) => app.listings.some((listing) => listing.store === store));
        const downloads = downloadsOf(metrics, stores);
        tiles.push({
            key: 'downloads',
            label: 'Téléchargements · 30 j',
            value: downloads === null ? MISSING : formatCount(downloads),
            hint: 'Les premières installations de l’app sur les 30 derniers jours relevés, tous stores.',
            change: previousCovered ? relativeChange(downloads, downloadsOf(previous, stores)) : null
        });
        for (const store of stores) {
            const rating = metrics.rating[store];
            const listing = app.listings.find((candidate) => candidate.store === store);
            tiles.push({
                key: `rating-${store}`,
                label: `Note ${STORE_LABELS[store]}`,
                value: rating === null ? MISSING : formatRating(rating),
                hint: `La note moyenne affichée ${ON_STORE[store]}.`,
                change: previousCovered ? ratingChange(rating, previous.rating[store]) : null,
                note:
                    listing?.ratingCount === null || listing?.ratingCount === undefined
                        ? undefined
                        : plural(listing.ratingCount, 'note', 'notes')
            });
        }

        const { slots, series } = downloadSeries(stats.data, stores);
        chart =
            stats.data.dataUntil === null ? null : (
                <TrendChart
                    compact
                    slots={slots}
                    resolution={stats.data.resolution}
                    series={series}
                    format={formatCount}
                    label={`Téléchargements de ${app.name} sur les 30 derniers jours relevés.`}
                />
            );
    }

    return (
        <section className={styles.linked} aria-label={app.name}>
            <div className={styles.linkedHead}>
                <div className={styles.linkedIdent}>
                    <h3 className={styles.linkedTitle}>
                        {app.name}
                        {app.foreign && (
                            <span
                                className={styles.badgeWrap}
                                title='Cette app appartient à un autre espace qui la partage ici'
                            >
                                <StatusBadge tone='accent'>partagée</StatusBadge>
                            </span>
                        )}
                        {app.planPaused && <PlanPausedBadge />}
                    </h3>
                    <StoreChips listings={app.listings} />
                </div>
                <div className={styles.actions}>
                    <FeatureSettingsButton
                        scope={{ kind: 'item', feature: 'appstores', itemId: String(app.id), itemLabel: app.name }}
                    />
                    <Button variant='secondary' icon='chevrons-right' onClick={() => openFeature('appstores', app.id)}>
                        Ouvrir dans Stores
                    </Button>
                    {/* La confirmation et le déliement sont à l'hôte, qui seul tient le lien. */}
                    {canWrite && (
                        <Button variant='ghost' onClick={onUnlink}>
                            Délier
                        </Button>
                    )}
                </div>
            </div>

            {!linked ? (
                <p className={styles.blockEmpty}>
                    Reliée à aucun store pour l’instant : ses chiffres attendent sa sortie.
                </p>
            ) : stats.data === null ? (
                stats.error ? (
                    <ErrorNote note={stats.error} inline />
                ) : (
                    <p className={styles.blockEmpty}>Chargement…</p>
                )
            ) : (
                <>
                    <StatBand tiles={tiles} />
                    {chart}
                </>
            )}
        </section>
    );
}

/** Le dialogue de la feature, pas une copie : Projets relie ce qui vient d'être créé. */
function LinkedAppDialog({
    open,
    onClose,
    onSaved
}: {
    open: boolean;
    onClose: () => void;
    onSaved: (appId: number) => void;
}) {
    return <AppDialog open={open} onClose={onClose} onSaved={(app) => onSaved(app.id)} />;
}

/** La tuile d'une app : ses téléchargements de la semaine, leur écart, et ses notes. */
function tileOf(summary: AppStoresAppSummary): SdkTileSummary {
    const { app, downloads, previousDownloads } = summary;
    if (app.listings.length === 0) {
        return { itemId: app.id, title: app.name, metrics: [], unavailable: 'Reliée à aucun store pour l’instant.' };
    }
    const change = relativeChange(downloads, previousDownloads);
    const metrics: SdkTileMetric[] = [
        {
            key: 'downloads',
            label: 'Téléchargements · 7 j',
            value: downloads === null ? MISSING : `${formatCount(downloads)}${change ? ` (${change.text})` : ''}`,
            // Une semaine qui fléchit n'est pas une panne : la tuile ne rougit pas pour ça.
            tone: 'neutral'
        }
    ];
    for (const store of STORE_ORDER) {
        const listing = app.listings.find((candidate) => candidate.store === store);
        if (listing?.rating === null || listing?.rating === undefined) continue;
        metrics.push({
            key: `rating-${store}`,
            label: `Note ${STORE_LABELS[store]}`,
            value: `${formatRating(listing.rating)} / 5`
        });
    }
    return { itemId: app.id, title: app.name, metrics };
}

/** Un seul aller-retour, quel que soit le nombre de tuiles : la liste porte déjà les chiffres de la semaine. */
async function summarize(appIds: readonly number[]): Promise<readonly SdkTileSummary[]> {
    let apps: AppStoresAppSummary[];
    try {
        apps = (await api.send('appstores.list', {})).apps;
    } catch {
        return appIds.map((id) => ({
            itemId: id,
            title: 'App indisponible',
            metrics: [],
            unavailable: 'Les apps de cet espace n’ont pas pu être lues.'
        }));
    }
    return appIds.map((id): SdkTileSummary => {
        const summary = apps.find((entry) => entry.app.id === id);
        return summary
            ? tileOf(summary)
            : { itemId: id, title: 'App supprimée', metrics: [], unavailable: 'Cette app n’est plus ici.' };
    });
}

export const clientProvider: AppStoresClientProvider = {
    listApps: async () =>
        (await api.send('appstores.list', {})).apps.map(({ app }) => ({
            id: app.id,
            name: app.name,
            foreign: app.foreign
        })),
    summarize,
    LinkedApp,
    AppDialog: LinkedAppDialog
};
