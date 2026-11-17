import { useCallback, useState } from 'react';
import { errorNote, useTasks, useWorkspacePermissions, type ErrorNoteInput } from 'deveye-sdk-client';
import type { AppStoresApp, AppStoresListing } from '../contracts/domain';

import { api } from './api';
import {
    formatAgo,
    formatDay,
    STORE_ICONS,
    STORE_LABELS,
    STORE_ORDER,
    SYNC_FAILURE_LABELS,
    versionState,
    type Tone
} from './format';
import styles from './style.module.css';

/** Au-delà, une fiche relue toutes les demi-heures a cessé de l'être : le service ne tourne plus pour elle. */
const STALE_SECONDS = 2 * 3600;

/** « 4 h » : le temps écoulé depuis un instant, à la minute près. */
function formatSince(epochSeconds: number): string {
    const minutes = Math.max(1, Math.floor((Date.now() / 1000 - epochSeconds) / 60));
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    return hours < 24 ? `${hours} h` : `${Math.floor(hours / 24)} j`;
}

interface ChipState {
    text: string;
    tone: Tone;
    title: string;
    failed: boolean;
}

/**
 * Ce que dit la puce d'une fiche : ce qui l'empêche (pas de compte, un échec),
 * sa synchronisation en cours ou en retard, sinon sa dernière version. Le
 * survol dit en plus jusqu'où vont ses données et quand elle a été relevée.
 * `busy` : une synchronisation demandée sur l'app, qui reprend ses échecs.
 */
function chipState(listing: AppStoresListing, paused: boolean, busy: boolean): ChipState {
    const store = STORE_LABELS[listing.store];
    if (listing.sourceId === null) {
        return {
            text: 'Sans compte',
            tone: 'warning',
            title: `${store} : aucun compte de store n’est choisi, rien ne se synchronise.`,
            failed: false
        };
    }
    const data =
        listing.dataUntil === null
            ? 'Aucune donnée pour l’instant'
            : `Données jusqu’au ${formatDay(listing.dataUntil)}`;
    const read = listing.lastSyncAt === null ? 'jamais relevée' : `relevée ${formatAgo(listing.lastSyncAt)}`;
    const state = (text: string, tone: Tone, what: string, failed = false): ChipState => ({
        text,
        tone,
        title: `${store} : ${what}\n${data}, ${read}.`,
        failed
    });

    if (listing.syncError !== null && !busy) {
        return state(SYNC_FAILURE_LABELS[listing.syncFailure ?? 'other'], 'danger', listing.syncError, true);
    }
    if (listing.syncError !== null) return state('Synchronisation…', 'accent', 'nouvelle tentative en cours.');
    if (listing.syncing) {
        return state('Synchronisation…', 'accent', 'l’historique se relève, les chiffres se complètent.');
    }
    if (!paused && listing.lastSyncAt !== null && Date.now() / 1000 - listing.lastSyncAt > STALE_SECONDS) {
        const since = formatSince(listing.lastSyncAt);
        return state(`Pas relevée depuis ${since}`, 'warning', `aucune synchronisation depuis ${since}.`);
    }
    const latest = listing.versions[0];
    if (latest) {
        const version = versionState(latest.state);
        const since = latest.since === null ? '' : `, depuis le ${formatDay(latest.since)}`;
        return state(
            `${latest.version} · ${version.label}`,
            version.tone,
            `version ${latest.version}, ${version.label.toLowerCase()}${since}.`
        );
    }
    return state(store, 'neutral', 'aucune version relevée.');
}

interface StoreChipProps {
    listing: AppStoresListing;
    state: ChipState;
    /** Présent quand la puce relance la synchronisation de l'app. */
    onRetry?: () => void;
}

/** Une fiche de store : son logo, puis son état ; en échec, de quoi relancer. */
function StoreChip({ listing, state, onRetry }: StoreChipProps) {
    const store = STORE_LABELS[listing.store];
    const content = (
        <>
            <span className={`icon icon-${STORE_ICONS[listing.store]} ${styles.chipIcon}`} aria-hidden='true' />
            {state.text !== store && <span className={styles.srOnly}>{store} : </span>}
            <span>{state.text}</span>
        </>
    );
    if (!onRetry) {
        return (
            <span className={styles.chip} data-tone={state.tone} title={state.title}>
                {content}
            </span>
        );
    }
    // Dans une rangée qui s'ouvre au clic : ni le clic ni la touche ne remontent jusqu'à elle.
    return (
        <button
            type='button'
            className={`${styles.chip} ${styles.chipRetry}`}
            data-tone={state.tone}
            title={`${state.title}\nCliquez pour une nouvelle tentative.`}
            onClick={(e) => {
                e.stopPropagation();
                onRetry();
            }}
            onKeyDown={(e) => e.stopPropagation()}
        >
            {content}
            <span className={styles.srOnly}>, nouvelle tentative</span>
            <span className={`icon icon-refresh ${styles.chipRetryIcon}`} aria-hidden='true' />
        </button>
    );
}

interface StoreChipsProps {
    app: AppStoresApp;
    /** La nouvelle tentative de l'écran ({@link useSyncNow}) ; sans elle, une puce en échec ne relance rien. */
    onRetry?: (appId: number) => Promise<void>;
}

/** Les fiches d'une app, toujours App Store puis Google Play, chacune avec son propre état. */
export function StoreChips({ app, onRetry }: StoreChipsProps) {
    const permissions = useWorkspacePermissions();
    const busy = useTasks({ feature: 'appstores', itemId: app.id, key: 'sync' }).length > 0;
    const [sending, setSending] = useState(false);
    // Une synchronisation part de chez l'app, active, avec l'écriture sur elle.
    const retryable =
        onRetry !== undefined &&
        !app.foreign &&
        !app.planPaused &&
        permissions.canFeature('appstores', 'write', String(app.id));
    const retry = () => {
        if (sending || !onRetry) return;
        setSending(true);
        void onRetry(app.id).finally(() => setSending(false));
    };

    const sorted = STORE_ORDER.flatMap((store) => app.listings.filter((listing) => listing.store === store));
    if (sorted.length === 0) return <span className={styles.chipNone}>Aucun store</span>;
    return (
        <span className={styles.chips}>
            {sorted.map((listing) => {
                const state = chipState(listing, app.planPaused, busy || sending);
                return (
                    <StoreChip
                        key={listing.store}
                        listing={listing}
                        state={state}
                        onRetry={state.failed && retryable ? retry : undefined}
                    />
                );
            })}
        </span>
    );
}

/** La nouvelle tentative qu'offrent les puces en échec, et son refus éventuel, que l'écran affiche. */
export function useSyncNow(): { syncNow: (appId: number) => Promise<void>; error: ErrorNoteInput | null } {
    const [error, setError] = useState<ErrorNoteInput | null>(null);
    const syncNow = useCallback(async (appId: number) => {
        setError(null);
        try {
            await api.send('appstores.syncNow', { appId });
        } catch (e) {
            setError(errorNote(e, 'La nouvelle tentative n’a pas pu partir.'));
        }
    }, []);
    return { syncNow, error };
}

export default StoreChips;
