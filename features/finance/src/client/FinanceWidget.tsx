import { useFinanceSummary } from './api';
import { formatMoney } from './format';
import styles from './style.module.css';

/**
 * La carte de l'accueil. Le statut dit : le disponible réel, ce qui reste une
 * fois mis de côté ce qui est dû. Sinon le solde, et les deux flux du mois.
 * Aucune animation de valeur.
 */
export function FinanceWidget() {
    const { summary, loading } = useFinanceSummary();

    if (loading || !summary) {
        return (
            <div className={styles.widget}>
                <div className={styles.widgetStat}>
                    <span className={styles.widgetValue}>…</span>
                </div>
                <span className={styles.widgetFoot}>Chargement…</span>
            </div>
        );
    }

    const currency = summary.currency;
    const available = summary.setAside === null ? null : summary.balance - summary.setAside;
    const shown = available ?? summary.balance;

    return (
        <div className={styles.widget}>
            <div className={styles.widgetStat}>
                <span className={`${styles.widgetValue} ${shown < 0 ? styles.widgetNegative : ''}`}>
                    {formatMoney(shown, currency, { compact: true })}
                </span>
                {available !== null && <span className={styles.widgetLabel}>disponible</span>}
            </div>
            <span className={styles.widgetFoot}>
                {summary.accountCount === 0 ? (
                    'Aucun compte'
                ) : summary.setAside !== null ? (
                    `${formatMoney(summary.setAside, currency, { compact: true })} à mettre de côté`
                ) : (
                    <>
                        <span className={styles.widgetIn}>
                            +{formatMoney(summary.income, currency, { compact: true })}
                        </span>
                        {' · '}
                        <span className={styles.widgetOut}>
                            {'\u2212'}
                            {formatMoney(summary.expense, currency, { compact: true })}
                        </span>
                        {' ce mois'}
                    </>
                )}
            </span>
        </div>
    );
}

export default FinanceWidget;
