import type { HomeFeatureId } from '@deveye/types';

import {
    featureCatalog,
    FEATURE_CATEGORIES,
    FEATURE_CATEGORY_ICON,
    FEATURE_CATEGORY_LABEL,
    featureCatalogEntry,
    featureRelations,
    featuresInCategory,
    type FeatureCatalogEntry
} from '../catalog';
import { FeatureArt } from '../art';
import styles from './AboutContent.module.css';

interface ExternalService {
    name: string;
    description: string;
}

const WEATHER_SERVICES: ExternalService[] = [
    { name: 'Open-Meteo', description: 'Prévisions météo et géocodage, fournisseur par défaut, sans clé API.' },
    { name: 'OpenWeatherMap', description: 'Fournisseur météo alternatif, activable avec votre propre clé API.' }
];

/** Services with a dedicated adapter for the home-screen shortcut previews (see src/Services/shortcutTemplates). */
const LINK_PREVIEW_SERVICES = ['GitHub', 'npm', 'Spotify', 'SoundCloud', 'Twitch', 'TikTok', 'Wikipédia', 'YouTube'];

/**
 * Ce que plusieurs fonctionnalités partagent sans liaison de l'une vers
 * l'autre. Le chiffrement se lit sur `holdSecrecy`, le canal d'alerte sur les
 * liaisons vers Mail ; seul le socle « appareils » est écrit à la main, faute
 * de drapeau, et peut donc se démoder.
 */
const AGENT_FEATURES: HomeFeatureId[] = ['devices', 'sentinel', 'cloudsync'];

function chipList(ids: readonly HomeFeatureId[]) {
    return ids
        .map((id) => featureCatalogEntry(id))
        .filter((entry): entry is FeatureCatalogEntry => entry !== undefined);
}

function FeatureChip({ entry }: { entry: FeatureCatalogEntry }) {
    return (
        <span className={styles.chip}>
            <span className={`icon icon-${entry.icon} ${styles.chipIcon}`} aria-hidden='true' />
            {entry.title}
        </span>
    );
}

/** Une fonctionnalité et ce qu'elle relie, dans les deux sens : la phrase
 *  change de sujet selon le bout où l'on se trouve. */
function FeatureRow({ entry }: { entry: FeatureCatalogEntry }) {
    const relations = featureRelations(entry.id);
    return (
        <li className={styles.feature}>
            {/* La vignette à côté du texte, pas au-dessus : empilées, elles
                feraient de cette fiche un dépliant. */}
            <FeatureArt id={entry.id} Art={entry.Art} className={styles.featureArt} />
            <div className={styles.featureText}>
                <span className={styles.featureHead}>
                    <span className={`icon icon-${entry.icon} ${styles.featureIcon}`} aria-hidden='true' />
                    <strong className={styles.featureTitle}>{entry.title}</strong>
                </span>
                <span className={styles.featureDesc}>{entry.description}</span>
                {relations.length > 0 && (
                    <ul className={styles.links}>
                        {relations.map((rel) => (
                            <li key={`${rel.entry.id}:${rel.outgoing ? 'out' : 'in'}`} className={styles.link}>
                                {/* La flèche porte le sens, la pastille porte l'autre bout, et
                                la phrase se lit pareil dans les deux cas : elle décrit
                                toujours ce que fait celui qui a déclaré la liaison. */}
                                <span
                                    className={`icon icon-${rel.outgoing ? 'arrow' : 'arrow-left'} ${styles.linkArrow}`}
                                    aria-hidden='true'
                                />
                                <FeatureChip entry={rel.entry} />
                                <span className={styles.linkWhat}>{rel.what}</span>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </li>
    );
}

/**
 * Body of the "About" info dialog, opened from the navbar's version pill. Les
 * fonctionnalités et leurs liens sont construits depuis le catalogue, donc
 * jamais en retard sur lui.
 */
export default function AboutContent() {
    const encrypted = featureCatalog().filter((f) => f.holdSecrecy);
    const alerting = featureCatalog().filter((f) => (f.links ?? []).some((l) => l.to === 'mail'));

    return (
        <>
            <p>
                DevEye est votre tableau de bord : appareils, fonctionnalités et raccourcis réunis sur un même accueil,
                que vous composez librement section par section.
            </p>

            <div>
                <p className={styles.sectionTitle}>Fonctionnalités</p>
                {FEATURE_CATEGORIES.map((category) => {
                    const entries = featuresInCategory(featureCatalog(), category);
                    if (entries.length === 0) return null;
                    return (
                        <div key={category} className={styles.category}>
                            <p className={styles.categoryTitle}>
                                <span
                                    className={`icon icon-${FEATURE_CATEGORY_ICON[category]} ${styles.categoryIcon}`}
                                    aria-hidden='true'
                                />
                                {FEATURE_CATEGORY_LABEL[category]}
                            </p>
                            <ul className={styles.featureList}>
                                {entries.map((entry) => (
                                    <FeatureRow key={entry.id} entry={entry} />
                                ))}
                            </ul>
                        </div>
                    );
                })}
            </div>

            <div>
                <p className={styles.sectionTitle}>Ce qu’elles partagent</p>
                <ul className={styles.serviceList}>
                    <li className={styles.serviceItem}>
                        <strong>Vos appareils</strong>
                        <span>Passent par l’agent installé sur la machine, et n’existent que tant qu’il répond.</span>
                        <div className={styles.chips}>
                            {chipList(AGENT_FEATURES).map((entry) => (
                                <FeatureChip key={entry.id} entry={entry} />
                            ))}
                        </div>
                    </li>
                    <li className={styles.serviceItem}>
                        <strong>Chiffrement par mot de passe</strong>
                        <span>
                            Leur contenu est chiffré par une clé dérivée de votre mot de passe. Le serveur ne le voit
                            jamais en clair, et un déverrouillage est demandé avant lecture.
                        </span>
                        <div className={styles.chips}>
                            {encrypted.map((entry) => (
                                <FeatureChip key={entry.id} entry={entry} />
                            ))}
                        </div>
                    </li>
                    <li className={styles.serviceItem}>
                        <strong>Alertes par e-mail</strong>
                        <span>Envoient leurs alertes par un compte configuré dans Mail, ou par un webhook.</span>
                        <div className={styles.chips}>
                            {alerting.map((entry) => (
                                <FeatureChip key={entry.id} entry={entry} />
                            ))}
                        </div>
                    </li>
                </ul>
            </div>

            <div>
                <p className={styles.sectionTitle}>Services externes utilisés</p>
                <ul className={styles.serviceList}>
                    {WEATHER_SERVICES.map((service) => (
                        <li key={service.name} className={styles.serviceItem}>
                            <strong>{service.name}</strong>
                            <span>{service.description}</span>
                        </li>
                    ))}

                    <li className={styles.serviceItem}>
                        <strong>Aperçus de liens</strong>
                        <span>
                            Récupèrent titre, image et métadonnées des raccourcis d&apos;accueil. Services dédiés :
                        </span>
                        <div className={styles.serviceTags}>
                            {LINK_PREVIEW_SERVICES.map((name) => (
                                <span key={name} className={styles.serviceTag}>
                                    {name}
                                </span>
                            ))}
                        </div>
                        <span className={styles.serviceNote}>
                            Tout autre lien utilise un aperçu générique (Open Graph, favicon).
                        </span>
                    </li>
                </ul>
            </div>
        </>
    );
}
