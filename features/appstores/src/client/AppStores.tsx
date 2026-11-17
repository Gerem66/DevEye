import { useState } from 'react';
import {
    Button,
    ErrorNote,
    FeatureSettingsButton,
    NotificationsNotice,
    PlanPausedNotice,
    SegmentedControl,
    StickyHeader,
    useActiveWorkspace,
    useLiveItemTarget,
    useLiveOutlines,
    useResource,
    useWorkspacePermissions
} from 'deveye-sdk-client';
import type { FeatureViewProps } from '@deveye/types/sdk/client';
import type { AppStore, AppStoresRange } from '../contracts/domain';

import { api } from './api';
import AppDetail from './AppDetail';
import AppDialog from './AppDialog';
import AppList from './AppList';
import { DEFAULT_RANGE, plural, STORE_LABELS, STORE_ORDER } from './format';
import OverviewTeaser from './OverviewTeaser';
import RangeBar from './Stats/RangeBar';
import StoresOverview from './StoresOverview';
import styles from './style.module.css';

type HomeView = 'apps' | 'overview';

/**
 * Les apps que l'espace suit sur l'App Store et sur Google Play. Rien n'est lu
 * chez les stores depuis cet écran : le service de fond relève les chiffres
 * avec les comptes de l'espace, et l'écran ne fait que lire ce qu'il a écrit.
 */
export function FeatureAppStores(_props: FeatureViewProps) {
    const permissions = useWorkspacePermissions();
    const canWrite = permissions.canFeature('appstores', 'write');
    const workspaceId = useActiveWorkspace()?.id ?? null;

    /** L'app ouverte ; `null` = la liste. */
    const [openedId, setOpenedId] = useState<number | null>(null);
    const [addOpen, setAddOpen] = useState(false);
    const [view, setView] = useState<HomeView>('apps');
    const [range, setRange] = useState<AppStoresRange>(DEFAULT_RANGE);
    const [chosenStore, setChosenStore] = useState<AppStore | 'all'>('all');

    const list = useResource(
        'appstores.list',
        () => api.send('appstores.list', {}).then((res) => res.apps),
        'Impossible de charger les apps.',
        [workspaceId]
    );
    // Les comptes ne se listent qu'avec l'écriture : la ligne de contexte et la
    // carte « reliez un compte » ne parlent qu'à qui peut agir.
    const sources = useResource(
        'appstores.sources',
        () => (canWrite ? api.send('appstores.listSources', {}).then((res) => res.sources) : Promise.resolve(null)),
        'Impossible de charger les comptes de store.',
        [workspaceId, canWrite]
    );

    const apps = list.data;

    /**
     * Présence : « qui regarde quelle app ». Ce composant possède `l1`. La cible
     * d'une téléportation reste posée jusqu'à ce que la liste soit là : c'est
     * elle qui dit si l'app existe encore.
     */
    useLiveItemTarget('l1', openedId === null ? null : String(openedId), apps !== null, (value) => {
        if (value === null) {
            setOpenedId(null);
            return;
        }
        const id = Number(value);
        if (!Number.isInteger(id) || !apps?.some((summary) => summary.app.id === id)) return;
        setOpenedId(id);
    });
    const outlineFor = useLiveOutlines('l1');

    if (openedId !== null) {
        return <OpenedApp key={openedId} appId={openedId} onBack={() => setOpenedId(null)} />;
    }

    const pausedHere = (apps ?? []).filter((summary) => summary.app.planPaused && !summary.app.foreign).length;
    const noSource = canWrite && sources.data !== null && sources.data.length === 0;
    // Une seule app n'a rien à cumuler : sa fiche dit déjà tout.
    const several = apps !== null && apps.length > 1;
    const shown: HomeView = several ? view : 'apps';
    const linkedStores = STORE_ORDER.filter((store) =>
        (apps ?? []).some((summary) => summary.app.listings.some((listing) => listing.store === store))
    );
    const store = chosenStore === 'all' || !linkedStores.includes(chosenStore) ? null : chosenStore;

    return (
        <div className={styles.root}>
            <StickyHeader>
                <header className={styles.header}>
                    <div>
                        <h2 className={styles.heading}>Stores</h2>
                        <p className={styles.subheading}>
                            {apps === null || apps.length === 0
                                ? 'Les téléchargements, les notes et les avis de vos apps, sur l’App Store et Google Play.'
                                : plural(apps.length, 'app suivie', 'apps suivies') +
                                  (sources.data
                                      ? ` · ${plural(sources.data.length, 'compte', 'comptes')} de store`
                                      : '')}
                        </p>
                    </div>
                    <div className={styles.actions}>
                        <FeatureSettingsButton scope={{ kind: 'feature', feature: 'appstores' }} />
                        {canWrite && (
                            <Button icon='add' onClick={() => setAddOpen(true)}>
                                Ajouter une app
                            </Button>
                        )}
                    </div>
                </header>
                {several && (
                    <div className={styles.tabsRow}>
                        <nav className={styles.tabs} role='tablist' aria-label='Vues de Stores'>
                            {(
                                [
                                    { id: 'apps', label: 'Apps', icon: 'appstores' },
                                    { id: 'overview', label: 'Vue d’ensemble', icon: 'activity' }
                                ] as const
                            ).map((entry) => (
                                <button
                                    key={entry.id}
                                    type='button'
                                    role='tab'
                                    aria-selected={entry.id === shown}
                                    className={entry.id === shown ? styles.tabActive : styles.tab}
                                    onClick={() => setView(entry.id)}
                                >
                                    <span className={`icon icon-${entry.icon} ${styles.tabIcon}`} aria-hidden='true' />
                                    <span>{entry.label}</span>
                                </button>
                            ))}
                        </nav>
                        {shown === 'overview' && (
                            <div className={styles.tabsTools}>
                                {linkedStores.length > 1 && (
                                    <SegmentedControl
                                        value={store ?? 'all'}
                                        options={[
                                            { value: 'all', label: 'Tous' },
                                            ...linkedStores.map((entry) => ({
                                                value: entry,
                                                label: STORE_LABELS[entry]
                                            }))
                                        ]}
                                        onChange={setChosenStore}
                                        aria-label='Store'
                                    />
                                )}
                                <RangeBar value={range} onChange={setRange} />
                            </div>
                        )}
                    </div>
                )}
            </StickyHeader>

            <ErrorNote note={list.error ?? sources.error} />

            {apps !== null && apps.length > 0 && (
                <NotificationsNotice scope={{ kind: 'feature', feature: 'appstores' }} />
            )}
            <PlanPausedNotice count={pausedHere} one='app suivie' many='apps suivies' />

            {noSource && (
                <div className={styles.emptyCard}>
                    <span className={`icon icon-key ${styles.emptyIcon}`} aria-hidden='true' />
                    <div className={styles.emptyText}>
                        <p className={styles.emptyTitle}>Reliez d’abord un compte de store</p>
                        <p>
                            Stores lit les chiffres de vos apps avec votre propre clé : une clé d’API App Store Connect
                            pour l’App Store, un compte de service Google pour Google Play. Les étapes sont expliquées
                            une à une, et chaque clé ne sert qu’à cet espace.
                        </p>
                    </div>
                    <FeatureSettingsButton
                        scope={{ kind: 'feature', feature: 'appstores' }}
                        initialSection='sources'
                        variant='primary'
                        label='Relier un compte'
                    />
                </div>
            )}

            {apps === null && !list.error && <p className={styles.empty}>Chargement…</p>}

            {apps !== null && apps.length === 0 && (
                <div className={styles.emptyCard}>
                    <span className={`icon icon-appstores ${styles.emptyIcon}`} aria-hidden='true' />
                    <div className={styles.emptyText}>
                        <p className={styles.emptyTitle}>Aucune app suivie</p>
                        <p>
                            {canWrite
                                ? 'Ajoutez-en une : ses téléchargements, ses notes et ses avis arrivent seuls, et vous pourrez répondre aux avis d’ici.'
                                : 'Un membre disposant du droit d’écriture peut en ajouter une.'}
                        </p>
                    </div>
                    {canWrite && (
                        <Button icon='add' onClick={() => setAddOpen(true)}>
                            Ajouter une app
                        </Button>
                    )}
                </div>
            )}

            {shown === 'overview' ? (
                <StoresOverview
                    range={range}
                    store={store}
                    stores={linkedStores}
                    canWrite={canWrite}
                    onOpen={setOpenedId}
                />
            ) : (
                apps !== null &&
                apps.length > 0 && (
                    <>
                        {several && <OverviewTeaser stores={linkedStores} onOpen={() => setView('overview')} />}
                        <AppList apps={apps} outlineFor={outlineFor} onOpen={setOpenedId} />
                    </>
                )
            )}

            <AppDialog
                open={addOpen}
                onClose={() => setAddOpen(false)}
                onSaved={(app) => {
                    setAddOpen(false);
                    // Une app qu'on vient d'ajouter s'ouvre : sa première synchronisation démarre sous les yeux.
                    setOpenedId(app.id);
                }}
            />
        </div>
    );
}

/**
 * L'app ouverte, remontée à chaque app : son chargement et son refus ne
 * débordent jamais sur la suivante.
 */
function OpenedApp({ appId, onBack }: { appId: number; onBack: () => void }) {
    const { data, error } = useResource(
        'appstores.detail',
        () => api.send('appstores.get', { appId }),
        'Impossible d’ouvrir cette app.',
        [appId]
    );

    // Disparue ou retirée à ce rôle pendant qu'on la regardait : l'ancienne fiche ne reste pas à l'écran.
    const lost = error !== null && (error.code === 'not_found' || error.code === 'forbidden');
    if (data === null || lost) {
        return (
            <div className={styles.root}>
                <div className={styles.header}>
                    <Button variant='ghost' icon='arrow-left' onClick={onBack}>
                        Stores
                    </Button>
                </div>
                {error ? <ErrorNote note={error} /> : <p className={styles.empty}>Chargement…</p>}
            </div>
        );
    }
    return (
        <>
            <ErrorNote note={error} />
            <AppDetail app={data.app} usage={data.usage} onBack={onBack} />
        </>
    );
}

export default FeatureAppStores;
