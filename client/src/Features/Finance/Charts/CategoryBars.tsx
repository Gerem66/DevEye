import type { FinanceCategory, FinanceCategoryShare } from '@deveye/types';

import { formatMoney } from '../format';
import { categoryOf, colorVar } from '../shared';
import styles from '../style.module.css';

interface CategoryBarsProps {
    shares: FinanceCategoryShare[];
    categories: FinanceCategory[];
    currency: string;
    /** Combien de lignes au plus; le reste est replié dans « Autres ». */
    limit?: number;
    onSelect?: (categoryId: number | null) => void;
}

/**
 * La répartition d'un sens, en barres horizontales.
 *
 * Des barres et non un camembert, pour trois raisons qui se cumulent: on compare
 * des longueurs bien mieux que des angles, les intitulés tiennent en clair à
 * côté de leur part au lieu de partir dans une légende, et une quinzaine de
 * catégories reste lisible là où un camembert devient une roue de couleurs.
 *
 * Au-delà de `limit` lignes, la queue est repliée dans « Autres »: une liste de
 * quarante barres dont trente pèsent moins de 1 % n'apprend rien et noie les
 * dix qui comptent.
 */
export function CategoryBars({ shares, categories, currency, limit = 8, onSelect }: CategoryBarsProps) {
    if (shares.length === 0) {
        return <p className={styles.placeholder}>Rien sur la période.</p>;
    }

    const total = shares.reduce((sum, share) => sum + share.amount, 0);
    const head = shares.slice(0, limit);
    const tail = shares.slice(limit);
    const tailAmount = tail.reduce((sum, share) => sum + share.amount, 0);
    const max = Math.max(1, ...head.map((share) => share.amount), tailAmount);

    const row = (key: string, label: string, icon: string, color: string, amount: number, onClick?: () => void) => {
        const Tag = onClick ? 'button' : 'div';
        return (
            <Tag
                key={key}
                type={onClick ? 'button' : undefined}
                className={onClick ? styles.shareRowAction : styles.shareRow}
                onClick={onClick}
            >
                <span className={styles.shareHead}>
                    <span className={`icon icon-${icon} ${styles.shareIcon}`} style={{ color }} />
                    <span className={styles.shareName}>{label}</span>
                    <span className={styles.shareAmount}>{formatMoney(amount, currency)}</span>
                </span>
                <span className={styles.shareTrack}>
                    {/* La largeur est une transition CSS et non une animation
                        framer-motion: elle doit rejouer à chaque changement de
                        fenêtre, sans remonter le composant. */}
                    <span
                        className={styles.shareFill}
                        style={{ width: `${(amount / max) * 100}%`, background: color }}
                    />
                </span>
                <span className={styles.shareShare}>
                    {total === 0 ? '' : `${Math.round((amount / total) * 100)} %`}
                </span>
            </Tag>
        );
    };

    return (
        <div className={styles.shares}>
            {head.map((share) => {
                const category = categoryOf(categories, share.categoryId);
                return row(
                    String(share.categoryId ?? 'none'),
                    category?.name ?? 'Sans catégorie',
                    category?.icon ?? 'other',
                    category ? colorVar(category.color) : 'var(--text-muted)',
                    share.amount,
                    onSelect ? () => onSelect(share.categoryId) : undefined
                );
            })}
            {tail.length > 0 &&
                row('others', `${tail.length} autres catégories`, 'details', 'var(--text-muted)', tailAmount)}
        </div>
    );
}

export default CategoryBars;
