import { useFinanceSummary } from './api';
import { formatMoney } from './format';
import styles from './style.module.css';

/**
 * La carte de l'accueil: le solde, et le mois en cours.
 *
 * Le solde plutôt qu'un décompte, parce que « 3 comptes » ne dit rien qu'on
 * veuille savoir d'un coup d'œil, là où « 4 210,50 € » dit exactement ce pour
 * quoi on ouvre la feature. Les deux flux du mois tiennent sur la ligne du bas:
 * un solde seul ne dit pas s'il monte ou s'il descend.
 *
 * Aucune animation de valeur: cette carte est sur la page d'accueil, et un
 * nombre qui s'anime à chaque ouverture attire l'œil pour une information dont
 * on ne fait rien à cet endroit.
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
