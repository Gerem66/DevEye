import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Button, humanizeError, useResourceVersion } from 'deveye-sdk-client';
import type {
    AudienceActivity,
    AudienceBreakdownItem,
    AudienceDimension,
    AudienceFunnel,
    AudienceOverview,
    AudienceRange,
    AudienceSite
} from '../contracts/domain';

import { api } from './api';
import { DIMENSION_LABELS, RANGE_LABELS, RANGES, formatCount } from './format';
import FunnelDetailDialog from './FunnelDetailDialog';
import FunnelDialog from './FunnelDialog';
import FunnelBar from './Stats/FunnelBar';
import Heatmap from './Stats/Heatmap';
import StatBand from './Stats/StatBand';
import TopList from './Stats/TopList';
import TrendChart from './Stats/TrendChart';
import styles from './style.module.css';

/**
 * Cadence du seul compteur qui vieillit sans que rien ne l'écrive.
 *
 * Trente secondes pour une fenêtre de cinq minutes : assez fin pour qu'un
 * visiteur parti disparaisse sans qu'on l'attende, assez rare pour que l'écran
 * ne pèse rien.
 */
const LIVE_REFRESH_MS = 30_000;

/** Les axes chargés d'emblée : ceux qu'on regarde à chaque fois. */
const ALWAYS: AudienceDimension[] = ['path', 'referrer', 'event', 'identity'];

/**
 * Les trois axes techniques, derrière un seul sélecteur.
 *
 * Ils répondent à la même question — « avec quoi me lit-on ? » — et les poser
 * côte à côte remplirait un tiers de l'écran de trois listes qu'on ne consulte
 * pas ensemble. Un seul panneau qu'on bascule tient la place d'un.
 */
const TECHNICAL: AudienceDimension[] = ['browser', 'os', 'device'];

interface SiteViewProps {
    site: AudienceSite;
    /** Définir un entonnoir est une écriture ; le lire n'en est pas une. */
    canWrite: boolean;
    /**
     * De quoi garnir la barre collante : à gauche l'intitulé du bloc, à droite
     * ses actions.
     *
     * Vides dans la feature Audience, où la fiche porte déjà son propre en-tête
     * collant juste au-dessus. Garnis dans l'onglet d'un projet, où il n'y en a
     * pas : sans eux, on perdait de vue quel site on regardait dès qu'on avait
     * défilé, et un projet peut en relier plusieurs. Les loger **dans** cette
     * barre plutôt qu'au-dessus évite un second bandeau collant à empiler.
     */
    heading?: ReactNode;
    actions?: ReactNode;
}

type Breakdowns = Partial<Record<AudienceDimension, AudienceBreakdownItem[]>>;

/**
 * Tout ce qu'on lit d'un site — le cœur partagé.
 *
 * Rendu à l'identique dans la feature Audience et dans l'onglet d'un projet.
 * Un site n'a pas à se présenter autrement selon la porte par laquelle on
 * entre, et une seconde implémentation aurait divergé au premier ajustement :
 * c'est la leçon de `RepoView` (module Git) et de `DatabaseView` (module Bases de données).
 *
 * Toutes les lectures sont **bornées par la fenêtre choisie** et repartent
 * ensemble quand elle change. Elles se relisent aussi sur `audience.stats`, que
 * l'ingestion invalide au plus une fois par minute et par espace : c'est ce qui
 * fait bouger les chiffres de tout le monde en même temps, sans que personne
 * n'ait à recharger.
 */
export function SiteView({ site, canWrite, heading, actions }: SiteViewProps) {
    const [range, setRange] = useState<AudienceRange>('7d');
    const [overview, setOverview] = useState<AudienceOverview | null>(null);
    const [breakdowns, setBreakdowns] = useState<Breakdowns>({});
    const [activity, setActivity] = useState<AudienceActivity | null>(null);
    const [live, setLive] = useState<number | null>(null);
    const [technical, setTechnical] = useState<AudienceDimension>('browser');
    const [funnels, setFunnels] = useState<AudienceFunnel[]>([]);
    /** `undefined` = fermé ; `null` = création ; un entonnoir = modification. */
    const [funnelEdit, setFunnelEdit] = useState<AudienceFunnel | null | undefined>(undefined);
    /** L'entonnoir dont on regarde le détail ; `null` = aucun. */
    const [funnelOpen, setFunnelOpen] = useState<AudienceFunnel | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    const statsVersion = useResourceVersion('audience.stats');

    /**
     * Y a-t-il déjà quelque chose à l'écran ?
     *
     * Toute la différence de traitement tient là. Au **premier** chargement il
     * n'y a rien à préserver, on montre une attente. Aux suivants — changement
     * de fenêtre, rafraîchissement — les données précédentes restent en place et
     * ne sont remplacées qu'à l'arrivée des nouvelles : vider d'abord ferait
     * s'effondrer les hauteurs puis se rouvrir la page, ce qui est un
     * scintillement pour rien.
     */
    const hasData = overview !== null;

    const load = useCallback(async () => {
        try {
            const [nextOverview, nextActivity, nextLive, nextFunnels, ...items] = await Promise.all([
                api.send('audience.overview', { siteId: site.id, range }),
                api.send('audience.activity', { siteId: site.id, range }),
                api.send('audience.live', { siteId: site.id }),
                api.send('audience.funnelList', { siteId: site.id, range }),
                ...[...ALWAYS, ...TECHNICAL].map((dimension) =>
                    api.send('audience.breakdown', { siteId: site.id, range, dimension })
                )
            ]);
            setOverview(nextOverview);
            setActivity(nextActivity);
            setLive(nextLive.visitors);
            setFunnels(nextFunnels.funnels);
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
        // Un site qui n'a jamais rien reçu n'a rien à montrer : l'écran d'attente
        // plus bas s'en charge. Sans cette garde, ouvrir un site fraîchement
        // déclaré lançait dix requêtes d'agrégat pour n'afficher aucun chiffre —
        // et les relançait à chaque battement de l'espace.
        if (site.lastEventAt === null) {
            setLoading(false);
            return;
        }
        setLoading(true);
        void load();
    }, [load, statsVersion, site.lastEventAt]);

    /**
     * Le compteur « en ce moment », et pourquoi il lui faut son propre minuteur.
     *
     * Sa valeur dépend de l'**heure qu'il est** : le serveur compte les visites
     * dont la dernière activité remonte à moins de cinq minutes, et cette
     * fenêtre glisse toute seule. Personne ne peut donc l'annoncer — il n'existe
     * aucun événement « ce visiteur vient de devenir inactif » à diffuser.
     *
     * Sans ce minuteur, le compteur ne bougeait qu'au rythme des invalidations
     * de l'ingestion, c'est-à-dire **seulement quand de nouvelles visites
     * arrivent** : un site qui se vide gardait son dernier chiffre affiché
     * indéfiniment. C'était exactement le contraire de ce qu'il promet.
     *
     * Même nature que la barre d'avancement d'une synchro mail (LIVE.md §4) :
     * une donnée qui vieillit hors de toute écriture. Une requête indexée par
     * tour, et rien d'autre.
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

    // Un site qui n'a jamais rien reçu n'a pas de statistiques à montrer, il a
    // une installation à finir. Afficher cinq zéros et une courbe plate ferait
    // chercher une panne là où il manque simplement une balise.
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
            {/* Le voile ne démonte rien : les chiffres précédents restent
                lisibles dessous et sont remplacés en place à l'arrivée des
                nouveaux. `pointer-events: none` pour qu'on puisse continuer à
                changer de fenêtre pendant qu'il tourne. */}
            {loading && (
                <div className={styles.viewVeil} aria-hidden='true'>
                    {/* Collant sur le corps défilant de la popup : la fiche est
                        plus haute que la fenêtre, et un indicateur figé en haut
                        du voile serait hors écran dès qu'on a défilé. Même
                        mécanique que le voile de synchronisation de Git. */}
                    <span className={`icon icon-spinner ${styles.spin} ${styles.veilSpinner}`} />
                </div>
            )}

            <div className={styles.viewHead}>
                {heading}
                <div className={styles.ranges} role='group' aria-label='Période'>
                    {RANGES.map((value) => (
                        <button
                            key={value}
                            type='button'
                            className={value === range ? styles.rangeActive : styles.range}
                            aria-pressed={value === range}
                            onClick={() => setRange(value)}
                        >
                            {RANGE_LABELS[value]}
                        </button>
                    ))}
                </div>
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

            {/* Les entonnoirs juste après les pages et les provenances : ils
                répondent au « pourquoi » de ce qu'on vient de lire, avant les
                axes techniques qui, eux, ne décrivent que le matériel. */}
            <section className={styles.panel}>
                <div className={styles.panelHead}>
                    <h3 className={styles.panelTitle}>Entonnoirs</h3>
                    {canWrite && (
                        <Button variant='ghost' icon='add' onClick={() => setFunnelEdit(null)}>
                            Nouvel entonnoir
                        </Button>
                    )}
                </div>

                {funnels.length === 0 ? (
                    <p className={styles.empty}>
                        Aucun entonnoir. Composez-en un à partir des pages et des événements déjà mesurés pour voir où
                        les visiteurs décrochent.
                    </p>
                ) : (
                    <div className={styles.funnelCards}>
                        {funnels.map((funnel) => (
                            <FunnelBar key={funnel.id} funnel={funnel} onOpen={() => setFunnelOpen(funnel)} />
                        ))}
                    </div>
                )}
            </section>

            <div className={styles.panels}>
                <section className={styles.panel}>
                    <div className={styles.panelHead}>
                        <h3 className={styles.panelTitle}>{DIMENSION_LABELS[technical]}</h3>
                        <div className={styles.segmented} role='group' aria-label='Axe technique'>
                            {TECHNICAL.map((dimension) => (
                                <button
                                    key={dimension}
                                    type='button'
                                    className={dimension === technical ? styles.segmentActive : styles.segment}
                                    aria-pressed={dimension === technical}
                                    onClick={() => setTechnical(dimension)}
                                >
                                    {DIMENSION_LABELS[dimension]}
                                </button>
                            ))}
                        </div>
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

            <FunnelDetailDialog
                funnel={funnelOpen}
                canWrite={canWrite}
                onClose={() => setFunnelOpen(null)}
                onEdit={() => {
                    // Du détail à l'édition sans repasser par la liste :
                    // « modifier » depuis un détail veut dire « celui-ci ».
                    setFunnelEdit(funnelOpen);
                    setFunnelOpen(null);
                }}
            />

            <FunnelDialog
                open={funnelEdit !== undefined}
                siteId={site.id}
                funnel={funnelEdit ?? null}
                onClose={() => setFunnelEdit(undefined)}
                onSaved={() => {
                    setFunnelEdit(undefined);
                    void load();
                }}
            />
        </div>
    );
}

/**
 * Le pas de la courbe, déduit de deux points consécutifs.
 *
 * Le serveur rend la résolution mais pas la largeur d'un seau — l'une nomme
 * l'autre, et la transporter deux fois aurait ouvert la porte à ce qu'elles se
 * contredisent. Sur un seul point, la largeur n'a aucune importance : rien ne
 * s'espace.
 */
function bucketOf(overview: AudienceOverview): number {
    if (overview.points.length >= 2) return overview.points[1].at - overview.points[0].at;
    return overview.resolution === 'hour' ? 3600 : overview.resolution === 'day' ? 86400 : 7 * 86400;
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
