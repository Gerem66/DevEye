import { PlanPausedBadge, StatusBadge, type LiveOutlineProps } from 'deveye-sdk-client';
import type { AppStoresAppSummary } from '../contracts/domain';

import AppIcon from './AppIcon';
import { countryName, formatCount, formatRating, MISSING, plural, STORE_LABELS, STORE_ORDER } from './format';
import { relativeChange } from './Stats/StatBand';
import StoreChips from './StoreChips';
import styles from './style.module.css';

interface AppListProps {
    apps: readonly AppStoresAppSummary[];
    /** Le halo de présence d'une app (`useLiveOutlines('l1')` de l'appelant). */
    outlineFor: (value: string | null) => LiveOutlineProps;
    onOpen: (appId: number) => void;
    onRetry: (appId: number) => Promise<void>;
}

/** Les apps suivies, une rangée chacune : ce qu'on vient lire en parcourant, le reste est dans la fiche. */
export function AppList({ apps, outlineFor, onOpen, onRetry }: AppListProps) {
    return (
        <ul className={styles.list}>
            {apps.map((summary) => (
                <AppRow
                    key={summary.app.id}
                    summary={summary}
                    outline={outlineFor(String(summary.app.id))}
                    onOpen={() => onOpen(summary.app.id)}
                    onRetry={onRetry}
                />
            ))}
        </ul>
    );
}

interface AppRowProps {
    summary: AppStoresAppSummary;
    outline: LiveOutlineProps;
    onOpen: () => void;
    onRetry: (appId: number) => Promise<void>;
}

function AppRow({ summary, outline, onOpen, onRetry }: AppRowProps) {
    const { app, downloads, previousDownloads } = summary;
    const change = relativeChange(downloads, previousDownloads);
    const listings = STORE_ORDER.flatMap((store) => app.listings.filter((listing) => listing.store === store));
    const rated = listings.filter((listing) => listing.rating !== null);
    const failing = listings.find((listing) => listing.syncError !== null);
    const syncing = !failing && !app.planPaused && listings.some((listing) => listing.syncing);

    return (
        <li className={styles.row} {...outline}>
            {/* Une bande fine en tête de rangée, comme Git et Mail : il se passe quelque chose, sans rien déplacer. */}
            {syncing && (
                <div className={styles.syncStrip} aria-hidden='true'>
                    <div className={styles.syncStripFill} />
                </div>
            )}
            {/* `div role="button"` : la rangée porte des paragraphes, interdits dans un `<button>`. */}
            <div
                className={styles.rowBody}
                role='button'
                tabIndex={0}
                onClick={onOpen}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onOpen();
                    }
                }}
            >
                <AppIcon app={app} />
                <div className={styles.rowMain}>
                    <p className={styles.rowName}>
                        <span className={styles.rowTitle}>{app.name}</span>
                        {app.foreign && (
                            <span
                                className={styles.badgeWrap}
                                title='Cette app appartient à un autre espace qui la partage ici'
                            >
                                <StatusBadge tone='accent'>partagée</StatusBadge>
                            </span>
                        )}
                        {app.planPaused && <PlanPausedBadge />}
                        <StoreChips app={app} onRetry={onRetry} />
                    </p>
                    <p className={styles.rowFoot}>
                        {rated.map((listing) => (
                            <span
                                key={listing.store}
                                className={styles.rating}
                                title={
                                    `Note ${STORE_LABELS[listing.store]}` +
                                    (listing.store === 'apple' ? ` (${countryName(app.ratingCountry)})` : '') +
                                    (listing.ratingCount === null
                                        ? ''
                                        : `, ${plural(listing.ratingCount, 'note', 'notes')}`)
                                }
                            >
                                <span className={`icon icon-star ${styles.ratingStar}`} aria-hidden='true' />
                                {formatRating(listing.rating ?? 0)}
                                <span className={styles.ratingStore}>{STORE_LABELS[listing.store]}</span>
                            </span>
                        ))}
                        {app.projectCount > 0 && <span>{plural(app.projectCount, 'projet', 'projets')}</span>}
                    </p>
                    {failing && (
                        <p className={styles.rowError} title={failing.syncError ?? undefined}>
                            {STORE_LABELS[failing.store]} : {failing.syncError}
                        </p>
                    )}
                </div>

                <div className={styles.rowStats}>
                    <span className={styles.rowFigure}>
                        <span className={styles.rowValue}>{downloads === null ? MISSING : formatCount(downloads)}</span>
                        <span className={styles.rowLabel}>téléchargements · 7 j</span>
                    </span>
                    {change && (
                        <span
                            className={styles.rowDelta}
                            data-tone={change.tone}
                            title='Par rapport aux 7 jours d’avant'
                        >
                            {change.text}
                        </span>
                    )}
                </div>
            </div>
        </li>
    );
}

export default AppList;
