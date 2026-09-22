import { useInvoicingSummary } from './api';
import { formatMoney } from './format';
import styles from './style.module.css';

/**
 * La carte de l'accueil : ce qui reste à encaisser plutôt qu'un décompte de
 * documents, parce que le nombre de pièces ne dit rien. La phrase du bas suit la
 * silhouette de toutes les autres cartes : poussée en bas à gauche, en petit et
 * en gris, et elle ne répète pas la valeur du dessus.
 */
export function InvoicingWidget() {
    const { summary, loading } = useInvoicingSummary();
    const currency = summary?.currency ?? 'EUR';

    const foot = () => {
        if (loading || summary === null) return 'Chargement…';
        if (summary.overdueCount > 0) {
            return (
                <span className={styles.widgetLate}>
                    {formatMoney(summary.overdueCents, currency)} en retard sur {summary.overdueCount} facture
                    {summary.overdueCount > 1 ? 's' : ''}
                </span>
            );
        }
        // Un devis accepté n'est pas une créance : il ne compte pas dans le montant
        // du dessus, et sans cette ligne rien ne bougerait ici quand un client
        // vient de dire oui. C'est pourtant le geste qui suit.
        if (summary.toBillCount > 0) {
            return `${formatMoney(summary.toBillCents, currency)} de devis acceptés à facturer`;
        }
        if (summary.outstandingCents > 0) return 'Rien en retard';
        if (summary.draftCount > 0) {
            return `${summary.draftCount} brouillon${summary.draftCount > 1 ? 's' : ''} en attente`;
        }
        return 'Aucune facture en attente';
    };

    return (
        <div className={styles.widget}>
            <div className={styles.widgetStat}>
                <span className={styles.widgetValue}>
                    {loading || summary === null
                        ? '—'
                        : formatMoney(summary.outstandingCents, currency, { compact: true })}
                </span>
                <span className={styles.widgetLabel}>à encaisser</span>
            </div>
            <span className={styles.widgetFoot}>{foot()}</span>
        </div>
    );
}

export default InvoicingWidget;
