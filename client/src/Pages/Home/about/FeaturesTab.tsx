import type { HomeFeatureId } from '@deveye/types';

import {
    FEATURE_CATEGORIES,
    FEATURE_CATEGORY_ICON,
    FEATURE_CATEGORY_LABEL,
    featureCatalogEntry,
    featureRelations,
    featuresInCategory,
    visibleFeatureCatalog,
    type FeatureCatalogEntry
} from '../catalog';
import Term from '@/Components/Term';

import { FeatureArt } from '../art';
import styles from './AboutContent.module.css';

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

export function FeatureChip({ entry }: { entry: FeatureCatalogEntry }) {
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

/** Les liaisons entre fonctionnalités visibles, chacune comptée une fois (du côté qui la déclare). */
export function countFeatureLinks(catalog: readonly FeatureCatalogEntry[]): number {
    return catalog.reduce(
        (n, f) => n + (f.links ?? []).filter((link) => featureCatalogEntry(link.to) !== undefined).length,
        0
    );
}

/** Les fonctionnalités et leurs liens, construits depuis le catalogue, donc jamais en retard sur lui. */
export default function FeaturesTab() {
    const catalog = visibleFeatureCatalog();
    const encrypted = catalog.filter((f) => f.holdSecrecy);
    const alerting = catalog.filter((f) => (f.links ?? []).some((l) => l.to === 'mail'));

    return (
        <>
            <div>
                {FEATURE_CATEGORIES.map((category) => {
                    const entries = featuresInCategory(catalog, category);
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
                        <span>
                            Envoient leurs alertes par un compte configuré dans Mail, ou par un{' '}
                            <Term id='webhook'>webhook</Term>.
                        </span>
                        <div className={styles.chips}>
                            {alerting.map((entry) => (
                                <FeatureChip key={entry.id} entry={entry} />
                            ))}
                        </div>
                    </li>
                </ul>
            </div>
        </>
    );
}
