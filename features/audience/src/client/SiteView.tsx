import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { humanizeError, SegmentedControl, useResourceVersion } from 'deveye-sdk-client';
import type {
    AudienceActivity,
    AudienceBreakdownItem,
    AudienceDimension,
    AudienceOverview,
    AudienceRange,
    AudienceSite
} from '../contracts/domain';

import { api } from './api';
import { bucketOf, DIMENSION_LABELS, formatCount } from './format';
import RangeBar from './RangeBar';
import Heatmap from './Stats/Heatmap';
import StatBand from './Stats/StatBand';
import TopList from './Stats/TopList';
import TrendChart from './Stats/TrendChart';
import styles from './style.module.css';

/**
 * Cadence du seul compteur qui vieillit sans que rien ne l'écrive : trente
 * secondes pour une fenêtre de cinq minutes.
 */
const LIVE_REFRESH_MS = 30_000;

/** Les axes chargés d'emblée : ceux qu'on regarde à chaque fois. */
const ALWAYS: AudienceDimension[] = ['path', 'referrer', 'event', 'identity'];

/**
 * Les trois axes techniques, derrière un seul sélecteur : ils répondent à la
 * même question et les poser côte à côte remplirait un tiers de l'écran de
 * listes qu'on ne consulte pas ensemble.
 */
const TECHNICAL: AudienceDimension[] = ['browser', 'os', 'device'];

interface SiteViewProps {
    site: AudienceSite;
    /**
     * De quoi garnir la barre collante : à gauche l'intitulé du bloc, à droite
     * ses actions. Vides dans la feature Audience, où la fiche porte déjà son
     * en-tête collant ; garnis dans l'onglet d'un projet, qui n'en a pas et peut
     * relier plusieurs sites.
     */
    heading?: ReactNode;
    actions?: ReactNode;
}

type Breakdowns = Partial<Record<AudienceDimension, AudienceBreakdownItem[]>>;

/**
 * La fréquentation d'un site, rendue à l'identique dans la feature Audience et
 * dans l'onglet d'un projet : un site n'a pas à se présenter autrement selon la
 * porte par laquelle on entre. Les entonnoirs sont à côté (`Funnels`), les
 * retours ailleurs encore : trois lectures qui ne répondent pas à la même
 * question.
 *
 * Toutes les lectures sont bornées par la fenêtre choisie et repartent ensemble
 * quand elle change. Elles se relisent aussi sur `audience.stats`, que
 * l'ingestion invalide au plus une fois par minute et par espace : les chiffres
 * de tout le monde bougent alors sans que personne ne recharge.
 */
export function SiteView({ site, heading, actions }: SiteViewProps) {
    const [range, setRange] = useState<AudienceRange>('7d');
    const [overview, setOverview] = useState<AudienceOverview | null>(null);
    const [breakdowns, setBreakdowns] = useState<Breakdowns>({});
    const [activity, setActivity] = useState<AudienceActivity | null>(null);
    const [live, setLive] = useState<number | null>(null);
    const [technical, setTechnical] = useState<AudienceDimension>('browser');
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    const statsVersion = useResourceVersion('audience.stats');

    /**
     * Y a-t-il déjà quelque chose à l'écran ? Au premier chargement il n'y a
     * rien à préserver, on montre une attente ; aux suivants les données
     * précédentes restent en place jusqu'à l'arrivée des nouvelles, vider
     * d'abord ferait s'effondrer les hauteurs pour rien.
     */
    const hasData = overview !== null;

    const load = useCallback(async () => {
        try {
            const [nextOverview, nextActivity, nextLive, ...items] = await Promise.all([
                api.send('audience.overview', { siteId: site.id, range }),
                api.send('audience.activity', { siteId: site.id, range }),
                api.send('audience.live', { siteId: site.id }),
                ...[...ALWAYS, ...TECHNICAL].map((dimension) =>
                    api.send('audience.breakdown', { siteId: site.id, range, dimension })
                )
            ]);
            setOverview(nextOverview);
            setActivity(nextActivity);
            setLive(nextLive.visitors);
            setBreakdowns(
                Object.fromEntries([...ALWAYS, ...TECHNICAL].map((d, i) => [d, items[i].items])) as Breakdowns
            );
            setError(null);
        } catch (e) {
            setError(humanizeError(e, 'Impossible de charger les statistiques.'));
        } finally {
            setLoading(false);
        }
    }, [site.id, range]);

    useEffect(() => {
        // Un site qui n'a jamais rien reçu n'a rien à montrer : l'écran d'attente plus
        // bas s'en charge. Sans cette garde, ouvrir un site fraîchement déclaré lance dix
        // requêtes d'agrégat pour aucun chiffre, à chaque battement de l'espace.
        if (site.lastEventAt === null) {
            setLoading(false);
            return;
        }
        setLoading(true);
        void load();
    }, [load, statsVersion, site.lastEventAt]);

    /**
     * Le compteur « en ce moment » a son propre minuteur parce que sa valeur
     * dépend de l'heure qu'il est : la fenêtre de cinq minutes glisse seule, et
     * aucun événement « ce visiteur vient de devenir inactif » n'existe.
     *
     * Sans lui, le compteur ne bougerait qu'à l'arrivée de nouvelles visites, et
     * un site qui se vide garderait son dernier chiffre indéfiniment.
     */
    useEffect(() => {
        if (site.lastEventAt === null) return;
        const timer = window.setInterval(() => {
            api.send('audience.live', { siteId: site.id })
                .then((res) => setLive(res.visitors))
                .catch(() => {
                    /* Lecture d'appoint : un échec passager n'efface rien. */
                });
        }, LIVE_REFRESH_MS);
        return () => window.clearInterval(timer);
    }, [site.id, site.lastEventAt]);

    // Un site qui n'a jamais rien reçu n'a pas de statistiques à montrer, il a une
    // installation à finir : cinq zéros et une courbe plate feraient chercher une panne
    // là où il manque une balise.
    if (site.lastEventAt === null) {
        return (
            <div className={styles.view}>
                {(heading || actions) && (
                    <div className={styles.viewHead}>
                        {heading}
                        {actions}
                    </div>
                )}
                <div className={styles.awaiting}>
                    <p className={styles.awaitingTitle}>Aucune mesure reçue pour l’instant.</p>
                    <p className={styles.awaitingHint}>
                        Collez la balise d’installation dans les pages à suivre. Les premiers chiffres apparaissent
                        quelques secondes après la première visite.
                    </p>
                </div>
            </div>
        );
    }

    // Premier chargement : rien à préserver, donc rien à voiler.
    if (!hasData && loading) {
        return (
            <p className={styles.loadingBlock}>
                <span className={`icon icon-spinner ${styles.spin}`} aria-hidden='true' /> Chargement des statistiques…
            </p>
        );
    }

    return (
        <div className={styles.view}>
            {/* Le voile ne démonte rien : les chiffres précédents restent lisibles
                dessous, et `pointer-events: none` laisse changer de fenêtre pendant
                qu'il tourne. */}
            {loading && (
                <div className={styles.viewVeil} aria-hidden='true'>
                    {/* Collant sur le corps défilant de la popup : la fiche est plus
                        haute que la fenêtre, et un indicateur figé en haut du voile
                        serait hors écran dès qu'on a défilé. */}
                    <span className={`icon icon-spinner ${styles.spin} ${styles.veilSpinner}`} />
                </div>
            )}

            <div className={styles.viewHead}>
                {heading}
                <RangeBar value={range} onChange={setRange} />
                {live !== null && live > 0 && (
                    <p className={styles.liveTag}>
                        <span className={styles.livePulse} aria-hidden='true' />
                        {formatCount(live)} en ce moment
                    </p>
                )}
                {actions}
            </div>

            {error && <p className={styles.error}>{error}</p>}

            {overview && (
                <StatBand
                    metrics={overview.metrics}
                    previous={overview.previous}
                    tracksReturning={site.visitorMode === 'persistent'}
                />
            )}

            {overview && (
                <TrendChart
                    points={overview.points}
                    resolution={overview.resolution}
                    from={overview.points[0]?.at ?? 0}
                    to={(overview.points[overview.points.length - 1]?.at ?? 0) + 1}
                    bucket={bucketOf(overview)}
                />
            )}

            <div className={styles.panels}>
                <TopList dimension='path' items={breakdowns.path ?? []} loading={loading} />
                <TopList dimension='referrer' items={breakdowns.referrer ?? []} loading={loading} />
            </div>

            <div className={styles.panels}>
                <section className={styles.panel}>
                    <div className={styles.panelHead}>
                        <h3 className={styles.panelTitle}>{DIMENSION_LABELS[technical]}</h3>
                        <SegmentedControl
                            value={technical}
                            options={TECHNICAL.map((dimension) => ({
                                value: dimension,
                                label: DIMENSION_LABELS[dimension]
                            }))}
                            aria-label='Axe technique'
                            onChange={setTechnical}
                        />
                    </div>
                    {/* Le titre est déjà rendu ci-dessus avec son sélecteur :
                        `TopList` n'apporterait ici qu'un doublon. */}
                    <BareTop items={breakdowns[technical] ?? []} loading={loading} />
                </section>

                <section className={styles.panel}>
                    <h3 className={styles.panelTitle}>Quand ils viennent</h3>
                    <Heatmap cells={activity?.cells ?? []} />
                    {activity && activity.timezones.length > 0 && (
                        <p className={styles.timezones}>
                            {activity.timezones.slice(0, 3).map((tz) => (
                                <span key={tz.label} className={styles.tzTag}>
                                    {tz.label || 'inconnu'} · {formatCount(tz.visitors)}
                                </span>
                            ))}
                        </p>
                    )}
                </section>
            </div>

            <div className={styles.panels}>
                <TopList dimension='event' items={breakdowns.event ?? []} loading={loading} />
                <TopList dimension='identity' items={breakdowns.identity ?? []} loading={loading} />
            </div>
        </div>
    );
}

/** Un classement sans son titre — le panneau technique porte déjà le sien. */
function BareTop({ items, loading }: { items: AudienceBreakdownItem[]; loading: boolean }) {
    const max = Math.max(1, ...items.map((item) => item.views));
    // Même règle que `TopList` : on ne remplace les lignes que par des lignes.
    if (loading && items.length === 0) return <p className={styles.empty}>Chargement…</p>;
    if (items.length === 0) return <p className={styles.empty}>Aucune visite sur cette période.</p>;
    return (
        <ol className={styles.topList}>
            {items.map((item, index) => (
                <li key={`${item.label}-${index}`} className={styles.topRow}>
                    <span
                        className={styles.topBar}
                        style={{ width: `${(item.views / max) * 100}%` }}
                        aria-hidden='true'
                    />
                    <span className={styles.topLabel}>{item.label || <em>illisible</em>}</span>
                    <span className={styles.topValue}>
                        {formatCount(item.views)}
                        <span className={styles.topVisitors}>{formatCount(item.visitors)} vis.</span>
                    </span>
                </li>
            ))}
        </ol>
    );
}

export default SiteView;
