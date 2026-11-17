import { Fragment, useEffect, useRef, useState } from 'react';
import { PROJECT_STATUS_LABELS } from '@deveye/types';
import {
    Button,
    ErrorNote,
    errorNote,
    FeatureSettingsButton,
    invalidate,
    NotificationsNotice,
    openFeature,
    PlanPausedBadge,
    PlanPausedNotice,
    SegmentedControl,
    StatusBadge,
    StickyHeader,
    TaskProgress,
    useLiveOutlines,
    useLiveSegment,
    useResource,
    useSubView,
    useTasks,
    useWorkspacePermissions,
    type ErrorNoteInput
} from 'deveye-sdk-client';
import type { AppStore, AppStoresApp, AppStoresRange, AppStoresUsage } from '../contracts/domain';

import { api } from './api';
import { DEFAULT_RANGE, formatAgo, formatDay, plural, STORE_LABELS, STORE_ORDER } from './format';
import Overview from './Overview';
import Revenue from './Revenue';
import Reviews from './Reviews';
import RangeBar from './Stats/RangeBar';
import Stability from './Stability';
import StoreChips from './StoreChips';
import styles from './style.module.css';

type Tab = 'overview' | 'reviews' | 'revenue' | 'stability';

/**
 * `syncNow` rend la main dès qu'il a réveillé le service, qui n'ouvre son
 * opération qu'en commençant la passe : le bouton reste retenu ce temps-là.
 */
const START_GRACE_MS = 10_000;

interface AppDetailProps {
    app: AppStoresApp;
    usage: readonly AppStoresUsage[];
    onBack: () => void;
}

/**
 * La fiche d'une app : son en-tête, ses onglets soulignés, puis le contenu de
 * l'onglet. Revenus n'existe que pour qui tient ce droit sur cette app, et
 * Stabilité que pour une app présente sur Google Play.
 */
export function AppDetail({ app, usage, onBack }: AppDetailProps) {
    const permissions = useWorkspacePermissions();
    const itemId = String(app.id);
    const canWrite = permissions.canFeature('appstores', 'write', itemId);
    const canRevenue = permissions.canExtra('appstores', 'revenue', itemId);
    // Les comptes se listent avec l'écriture sur la fonctionnalité : ce qu'une clé ne lit pas ne se dit qu'à eux.
    const canListSources = permissions.canFeature('appstores', 'write');
    const sources = useResource(
        'appstores.sources',
        () =>
            canListSources ? api.send('appstores.listSources', {}).then((res) => res.sources) : Promise.resolve(null),
        'Les comptes de store n’ont pas pu être lus.',
        [canListSources]
    );

    const hasGoogle = app.listings.some((listing) => listing.store === 'google');
    const tabs: { id: Tab; label: string; icon: string }[] = [
        { id: 'overview', label: 'Aperçu', icon: 'activity' },
        { id: 'reviews', label: 'Avis', icon: 'chat-outline' },
        ...(canRevenue ? [{ id: 'revenue' as const, label: 'Revenus', icon: 'finance' }] : []),
        ...(hasGoogle ? [{ id: 'stability' as const, label: 'Stabilité', icon: 'bug' }] : [])
    ];
    const [chosen, setChosen] = useState<Tab>('overview');
    const [range, setRange] = useState<AppStoresRange>(DEFAULT_RANGE);
    const [chosenStore, setChosenStore] = useState<AppStore | 'all'>('all');
    // Le store choisi vaut pour les onglets qui comparent les deux ; la Stabilité n'est que Google Play.
    const linkedStores = STORE_ORDER.filter((store) => app.listings.some((listing) => listing.store === store));
    const store = chosenStore !== 'all' && linkedStores.includes(chosenStore) ? chosenStore : null;
    const shown =
        store === null ? app : { ...app, listings: app.listings.filter((listing) => listing.store === store) };
    // Un onglet qui disparaît (droit retiré, fiche Google Play retirée) ramène à l'aperçu.
    const tab = tabs.some((entry) => entry.id === chosen) ? chosen : 'overview';

    // Présence : `AppStores` possède `l1` (l'app), cette fiche possède `l2` (l'onglet) et l'entoure.
    useLiveSegment('l2', tab);
    const outlineOf = useLiveOutlines('l2');
    useSubView(`app/${tab}`);

    const tasks = useTasks({ feature: 'appstores', itemId: app.id });
    const running = tasks.length > 0;
    const [starting, setStarting] = useState(false);
    const [error, setError] = useState<ErrorNoteInput | null>(null);

    useEffect(() => {
        if (running) setStarting(false);
    }, [running]);

    useEffect(() => {
        if (!starting) return;
        const timer = window.setTimeout(() => setStarting(false), START_GRACE_MS);
        return () => window.clearTimeout(timer);
    }, [starting]);

    // Une passe qui n'a rien relevé ne prévient personne : sa date et son refus éventuel se relisent ici.
    const ran = useRef(false);
    useEffect(() => {
        if (ran.current && !running) {
            invalidate(
                'appstores.detail',
                'appstores.list',
                'appstores.stats',
                'appstores.reviews',
                'appstores.revenue'
            );
        }
        ran.current = running;
    }, [running]);

    const syncNow = async () => {
        setStarting(true);
        setError(null);
        try {
            await api.send('appstores.syncNow', { appId: app.id });
        } catch (e) {
            setStarting(false);
            setError(errorNote(e, 'La synchronisation n’a pas pu être lancée.'));
        }
    };

    /** Les réglages ont pu changer ce que la fiche montre : elle se relit à leur fermeture, pas à leur montage. */
    const settingsOpened = useRef(false);
    const onSettingsOpenChange = (open: boolean) => {
        if (open) {
            settingsOpened.current = true;
            return;
        }
        if (!settingsOpened.current) return;
        settingsOpened.current = false;
        invalidate('appstores.detail');
    };

    // Chaque store publie à son rythme : un relevé commun laisserait croire l'autre à jour.
    const freshness = STORE_ORDER.flatMap((store) => {
        const listing = app.listings.find((candidate) => candidate.store === store);
        if (!listing || listing.lastSyncAt === null) return [];
        return [
            {
                store,
                text:
                    listing.dataUntil === null
                        ? `${STORE_LABELS[store]} : aucune donnée pour l’instant`
                        : `${STORE_LABELS[store]} : données jusqu’au ${formatDay(listing.dataUntil)}`,
                title: `Relevé ${formatAgo(listing.lastSyncAt)}`
            }
        ];
    });
    const hasSource = app.listings.some((listing) => listing.sourceId !== null);
    const syncBlocked = app.planPaused
        ? 'Au-delà de l’offre, la synchronisation de cette app est en pause.'
        : !hasSource
          ? 'Aucun compte de store n’est choisi pour cette app : choisissez-en un dans ses réglages.'
          : null;

    return (
        <div className={styles.root}>
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
                                <span className={styles.headingText}>{app.name}</span>
                                {app.foreign && (
                                    <span
                                        className={styles.badgeWrap}
                                        title='Cette app appartient à un autre espace qui la partage ici'
                                    >
                                        <StatusBadge tone='accent'>partagée</StatusBadge>
                                    </span>
                                )}
                                {app.planPaused && <PlanPausedBadge />}
                            </h2>
                            <div className={styles.subheading}>
                                <StoreChips listings={app.listings} />
                                {freshness.map((entry, index) => (
                                    <Fragment key={entry.store}>
                                        {index > 0 && <span aria-hidden='true'>·</span>}
                                        <span title={entry.title}>{entry.text}</span>
                                    </Fragment>
                                ))}
                            </div>
                        </div>
                    </div>
                    <div className={styles.actions}>
                        {/* Une app partagée ici se synchronise chez elle, avec ses comptes. */}
                        {canWrite && !app.foreign && app.listings.length > 0 && (
                            <Button
                                variant='secondary'
                                icon='refresh'
                                disabled={starting || running || syncBlocked !== null}
                                title={syncBlocked ?? 'Relire maintenant les chiffres, les avis et les versions'}
                                onClick={() => void syncNow()}
                            >
                                {starting || running ? 'Synchronisation…' : 'Synchroniser'}
                            </Button>
                        )}
                        {/* Ses réglages, dont son nom, ses fiches de store et sa suppression
                            (onglet Général). Supprimée ou déplacée depuis la coquille,
                            l'app n'est plus ici : la fiche revient à la liste. */}
                        <FeatureSettingsButton
                            scope={{ kind: 'item', feature: 'appstores', itemId, itemLabel: app.name }}
                            onGone={onBack}
                            onOpenChange={onSettingsOpenChange}
                        />
                    </div>
                </header>

                <div className={styles.tabsRow}>
                    <nav className={styles.tabs} role='tablist' aria-label='Sections de l’app'>
                        {tabs.map((entry) => (
                            <button
                                key={entry.id}
                                type='button'
                                role='tab'
                                aria-selected={entry.id === tab}
                                className={entry.id === tab ? styles.tabActive : styles.tab}
                                onClick={() => setChosen(entry.id)}
                                {...outlineOf(entry.id)}
                            >
                                <span className={`icon icon-${entry.icon} ${styles.tabIcon}`} aria-hidden='true' />
                                <span>{entry.label}</span>
                            </button>
                        ))}
                    </nav>
                    {app.listings.length > 0 && (
                        <div className={styles.tabsTools}>
                            {linkedStores.length > 1 && tab !== 'stability' && (
                                <SegmentedControl
                                    value={store ?? 'all'}
                                    options={[
                                        { value: 'all', label: 'Tous' },
                                        ...linkedStores.map((entry) => ({ value: entry, label: STORE_LABELS[entry] }))
                                    ]}
                                    onChange={setChosenStore}
                                    aria-label='Store'
                                />
                            )}
                            <RangeBar value={range} onChange={setRange} />
                        </div>
                    )}
                </div>
            </StickyHeader>

            <ErrorNote note={error} />
            {tasks.map((task) => (
                <TaskProgress key={task.id} task={task} />
            ))}
            <PlanPausedNotice count={app.planPaused && !app.foreign ? 1 : 0} one='app suivie' many='apps suivies' />
            <NotificationsNotice scope={{ kind: 'item', feature: 'appstores', itemId, itemLabel: app.name }} />

            {tab === 'overview' && (
                <Overview app={shown} store={store} sources={sources.data} canWrite={canWrite} range={range} />
            )}
            {tab === 'reviews' && (
                <Reviews app={shown} store={store} sources={sources.data} canWrite={canWrite} range={range} />
            )}
            {tab === 'revenue' && <Revenue app={shown} store={store} sources={sources.data} range={range} />}
            {tab === 'stability' && <Stability app={app} sources={sources.data} range={range} />}

            {tab === 'overview' && usage.length > 0 && (
                <section className={styles.usage}>
                    <h3 className={styles.sectionTitle}>{plural(usage.length, 'projet', 'projets')}</h3>
                    <ul className={styles.usageList}>
                        {usage.map((project) => (
                            <li key={project.projectId}>
                                {/* La téléportation, garde d'accès comprise : le chemin commun vers un autre élément. */}
                                <button
                                    type='button'
                                    className={styles.usageItem}
                                    onClick={() => openFeature('projects', project.projectId)}
                                >
                                    <span className='icon icon-projects' aria-hidden='true' />
                                    <span className={styles.usageName}>{project.title}</span>
                                    <span className={styles.status} data-status={project.status}>
                                        {PROJECT_STATUS_LABELS[project.status]}
                                    </span>
                                </button>
                            </li>
                        ))}
                    </ul>
                </section>
            )}
        </div>
    );
}

export default AppDetail;
