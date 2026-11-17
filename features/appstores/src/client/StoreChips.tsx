import type { AppStoresListing } from '../contracts/domain';

import { formatDay, STORE_ICONS, STORE_LABELS, STORE_ORDER, versionState, type Tone } from './format';
import styles from './style.module.css';

/** Ce que la puce d'une fiche de store dit : d'abord ce qui empêche, puis l'état de la version. */
function chipState(listing: AppStoresListing): { text: string; tone: Tone; title: string } {
    const store = STORE_LABELS[listing.store];
    if (listing.syncError) return { text: 'Erreur', tone: 'danger', title: `${store} : ${listing.syncError}` };
    if (listing.sourceId === null) {
        return {
            text: 'Sans compte',
            tone: 'warning',
            title: `${store} : aucun compte de store n’est choisi, rien ne se synchronise.`
        };
    }
    if (listing.lastSyncAt === null) {
        return { text: 'En attente', tone: 'neutral', title: `${store} : pas encore synchronisée.` };
    }
    const latest = listing.versions[0];
    if (latest) {
        const state = versionState(latest.state);
        const since = latest.since === null ? '' : `, depuis le ${formatDay(latest.since)}`;
        return {
            text: `${latest.version} · ${state.label}`,
            tone: state.tone,
            title: `${store} : version ${latest.version}, ${state.label.toLowerCase()}${since}.`
        };
    }
    return { text: store, tone: 'neutral', title: store };
}

/** Une fiche de store : son logo d'abord, puis son état. */
export function StoreChip({ listing }: { listing: AppStoresListing }) {
    const state = chipState(listing);
    const store = STORE_LABELS[listing.store];
    return (
        <span className={styles.chip} data-tone={state.tone} title={state.title}>
            <span className={`icon icon-${STORE_ICONS[listing.store]} ${styles.chipIcon}`} aria-hidden='true' />
            {state.text !== store && <span className={styles.srOnly}>{store} : </span>}
            <span>{state.text}</span>
        </span>
    );
}

/** Les fiches d'une app, toujours App Store puis Google Play. */
export function StoreChips({ listings }: { listings: readonly AppStoresListing[] }) {
    const sorted = STORE_ORDER.flatMap((store) => listings.filter((listing) => listing.store === store));
    if (sorted.length === 0) return <span className={styles.chipNone}>Aucun store</span>;
    return (
        <span className={styles.chips}>
            {sorted.map((listing) => (
                <StoreChip key={listing.store} listing={listing} />
            ))}
        </span>
    );
}

export default StoreChips;
