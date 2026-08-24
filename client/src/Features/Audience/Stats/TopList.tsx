import type { AudienceBreakdownItem, AudienceDimension } from '@deveye/types';

import { DIMENSION_EMPTY, DIMENSION_LABELS, formatCount } from '../format';
import styles from '../style.module.css';

interface TopListProps {
    dimension: AudienceDimension;
    items: AudienceBreakdownItem[];
    /** `null` tant que la première réponse n'est pas arrivée. */
    loading: boolean;
}

/**
 * Un classement : les premiers d'un axe, avec leur part.
 *
 * La barre est **derrière** le texte et non à côté : mise en colonne, elle
 * aurait volé la moitié de la largeur à des libellés qui en ont besoin (un
 * chemin est long, un fuseau aussi). En fond, elle se lit d'un coup d'œil sans
 * rien prendre à personne — c'est la même idée que la barre d'avancement qui
 * traverse une carte de projet.
 *
 * L'échelle est celle du **premier de la liste**, jamais du total : sur un axe
 * où trois cents valeurs se partagent le trafic, des parts rapportées au total
 * seraient toutes invisibles.
 */
export function TopList({ dimension, items, loading }: TopListProps) {
    const max = Math.max(1, ...items.map((item) => item.views));

    return (
        <section className={styles.panel}>
            <h3 className={styles.panelTitle}>{DIMENSION_LABELS[dimension]}</h3>
            {/* On ne bascule sur « Chargement… » que s'il n'y a **rien** à
                montrer. Sinon les lignes précédentes tiennent la place et sont
                remplacées à l'arrivée des nouvelles : c'est ce qui évite que la
                page s'effondre puis se rouvre à chaque changement de fenêtre. */}
            {loading && items.length === 0 ? (
                <p className={styles.empty}>Chargement…</p>
            ) : items.length === 0 ? (
                <p className={styles.empty}>{DIMENSION_EMPTY[dimension]}</p>
            ) : (
                <ol className={styles.topList}>
                    {items.map((item, index) => (
                        <li key={`${item.label}-${index}`} className={styles.topRow}>
                            <span
                                className={styles.topBar}
                                style={{ width: `${(item.views / max) * 100}%` }}
                                aria-hidden='true'
                            />
                            {/* Un libellé vide n'est pas une absence : c'est un
                                blob qu'on n'a pas su déchiffrer. Le dire évite
                                de chercher une visite fantôme. */}
                            <span className={styles.topLabel} title={item.label || 'Libellé illisible'}>
                                {item.label || <em>illisible</em>}
                            </span>
                            <span className={styles.topValue}>
                                {formatCount(item.views)}
                                <span className={styles.topVisitors}>{formatCount(item.visitors)} vis.</span>
                            </span>
                        </li>
                    ))}
                </ol>
            )}
        </section>
    );
}

export default TopList;
