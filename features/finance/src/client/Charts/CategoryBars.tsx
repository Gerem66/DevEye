import type { FinanceCategory, FinanceCategoryShare } from '../../contracts/domain';

import { formatMoney } from '../format';
import { categoryOf, colorVar } from '../shared';
import styles from '../style.module.css';

interface CategoryBarsProps {
    shares: FinanceCategoryShare[];
    categories: FinanceCategory[];
    currency: string;
    /** Combien de lignes au plus ; le reste est replié dans « Autres ». */
    limit?: number;
}

/**
 * Des barres et non un camembert : on compare des longueurs mieux que des
 * angles, et les intitulés tiennent à côté.
 */
export function CategoryBars({ shares, categories, currency, limit = 8 }: CategoryBarsProps) {
    if (shares.length === 0) {
        return <p className={styles.placeholder}>Rien sur la période.</p>;
    }

    const total = shares.reduce((sum, share) => sum + share.amount, 0);
    const head = shares.slice(0, limit);
    const tail = shares.slice(limit);
    const tailAmount = tail.reduce((sum, share) => sum + share.amount, 0);
    const max = Math.max(1, ...head.map((share) => share.amount), tailAmount);

    const row = (key: string, label: string, icon: string, color: string, amount: number) => (
        <div key={key} className={styles.shareRow}>
            <span className={styles.shareHead}>
                <span className={`icon icon-${icon} ${styles.shareIcon}`} style={{ color }} aria-hidden='true' />
                <span className={styles.shareName}>{label}</span>
                <span className={styles.shareAmount}>{formatMoney(amount, currency)}</span>
            </span>
            <span className={styles.shareTrack}>
                <span className={styles.shareFill} style={{ width: `${(amount / max) * 100}%`, background: color }} />
            </span>
            <span className={styles.shareShare}>{total === 0 ? '' : `${Math.round((amount / total) * 100)} %`}</span>
        </div>
    );

    return (
        <div className={styles.shares}>
            {head.map((share) => {
                const category = categoryOf(categories, share.categoryId);
                return row(
                    String(share.categoryId ?? 'none'),
                    category?.name ?? 'Sans catégorie',
                    category?.icon ?? 'other',
                    category ? colorVar(category.color) : 'var(--text-muted)',
                    share.amount
                );
            })}
            {tail.length > 0 &&
                row('others', `${tail.length} autres catégories`, 'details', 'var(--text-muted)', tailAmount)}
        </div>
    );
}

export default CategoryBars;
