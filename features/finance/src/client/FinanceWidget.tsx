import { useFinanceSummary } from './api';
import { formatMoney } from './format';
import styles from './style.module.css';

/**
 * La carte de l'accueil : le solde plutôt qu'un décompte, et les deux flux du
 * mois. Aucune animation de valeur.
 */
export function FinanceWidget() {
    const { summary, loading } = useFinanceSummary();
    const currency = summary?.currency ?? 'EUR';

    return (
        <div className={styles.widget}>
            <div className={styles.widgetStat}>
                <span className={`${styles.widgetValue} ${(summary?.balance ?? 0) < 0 ? styles.widgetNegative : ''}`}>
                    {loading || !summary ? '—' : formatMoney(summary.balance, currency, { compact: true })}
                </span>
            </div>
            <span className={styles.widgetFoot}>
                {loading || !summary ? (
                    'Chargement…'
                ) : summary.accountCount === 0 ? (
                    'Aucun compte'
                ) : (
                    <>
                        <span className={styles.widgetIn}>
                            +{formatMoney(summary.income, currency, { compact: true })}
                        </span>
                        {' · '}
                        <span className={styles.widgetOut}>
                            −{formatMoney(summary.expense, currency, { compact: true })}
                        </span>
                        {' ce mois'}
                    </>
                )}
            </span>
        </div>
    );
}

export default FinanceWidget;
