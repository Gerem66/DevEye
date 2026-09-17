import {
    AUDIENCE_BREAKDOWN_DEFAULT,
    AUDIENCE_BREAKDOWN_MAX,
    type AudienceBreakdownItem,
    type AudienceDimension
} from '../../contracts/domain';

import { DIMENSION_EMPTY, DIMENSION_HINTS, DIMENSION_LABELS, formatCount, rowTitle } from '../format';
import styles from '../style.module.css';

interface TopRowsProps {
    dimension: AudienceDimension;
    items: AudienceBreakdownItem[];
    /** `null` tant que la première réponse n'est pas arrivée. */
    loading: boolean;
    /**
     * Le classement va-t-il déjà jusqu'au plafond ? Sinon, une liste pleine
     * propose d'aller le chercher, et `onExpand` le demande.
     */
    expanded: boolean;
    onExpand: () => void;
}

/**
 * Les lignes d'un classement, avec leur part.
 *
 * La barre est derrière le texte et non à côté : en colonne, elle volerait la
 * moitié de la largeur à des libellés qui en ont besoin.
 *
 * L'échelle est celle du premier de la liste et jamais du total : sur un axe où
 * trois cents valeurs se partagent le trafic, des parts rapportées au total
 * seraient toutes invisibles.
 *
 * Huit lignes d'emblée, le plafond sur demande : un classement n'est jamais la
 * liste exhaustive, et le dire évite de croire qu'une page absente n'a jamais
 * été vue.
 */
export function TopRows({ dimension, items, loading, expanded, onExpand }: TopRowsProps) {
    const max = Math.max(1, ...items.map((item) => item.views));

    // On ne bascule sur « Chargement… » que s'il n'y a rien à montrer : sinon
    // les lignes précédentes tiennent la place jusqu'à l'arrivée des nouvelles,
    // et la page ne s'effondre pas à chaque changement de fenêtre.
    if (loading && items.length === 0) return <p className={styles.empty}>Chargement…</p>;
    if (items.length === 0) return <p className={styles.empty}>{DIMENSION_EMPTY[dimension]}</p>;

    return (
        <>
            <ol className={styles.topList}>
                {items.map((item, index) => (
                    <li key={`${item.label}-${index}`} className={styles.topRow}>
                        <span
                            className={styles.topBar}
                            style={{ width: `${(item.views / max) * 100}%` }}
                            aria-hidden='true'
                        />
                        {/* Un libellé vide n'est pas une absence, c'est un blob
                            qu'on n'a pas su déchiffrer : le dire évite de chercher
                            une visite fantôme. */}
                        <span className={styles.topLabel} title={item.label || 'Libellé illisible'}>
                            {item.label || <em>illisible</em>}
                        </span>
                        <span className={styles.topValue} title={rowTitle(dimension, item.views, item.visitors)}>
                            {formatCount(item.views)}
                            <span className={styles.topVisitors}>{formatCount(item.visitors)} vis.</span>
                        </span>
                    </li>
                ))}
            </ol>
            {/* Une liste pleine peut cacher des lignes ; une liste au plafond en cache
                peut-être encore, et le dit. */}
            {!expanded && items.length >= AUDIENCE_BREAKDOWN_DEFAULT && (
                <button type='button' className={styles.topMore} disabled={loading} onClick={onExpand}>
                    Tout afficher
                </button>
            )}
            {expanded && items.length >= AUDIENCE_BREAKDOWN_MAX && (
                <p className={styles.topCap}>Les {AUDIENCE_BREAKDOWN_MAX} premières lignes seulement.</p>
            )}
        </>
    );
}

/** Un classement titré : les premiers d'un axe. */
export function TopList({ dimension, ...rows }: TopRowsProps) {
    return (
        <section className={styles.panel}>
            <h3 className={styles.panelTitle} title={DIMENSION_HINTS[dimension]}>
                {DIMENSION_LABELS[dimension]}
            </h3>
            <TopRows dimension={dimension} {...rows} />
        </section>
    );
}

export default TopList;
