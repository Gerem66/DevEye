import { totalOpen, useSentinelCount, worstSeverity } from './store';
import styles from './style.module.css';

/**
 * La carte de grille répond à « à quel point », pas « combien » : la pire
 * gravité teinte. Sans appareil surveillé, on le dit plutôt qu'un « 0 constat ».
 */
export function SentinelWidget() {
    const { open, watched, loading } = useSentinelCount();
    const total = totalOpen(open);
    const worst = worstSeverity(open);

    // Rien d'ouvert ne se teinte pas : l'accent est l'état calme, seul un
    // constat net bascule la couleur.
    const tone = worst === 'critical' || worst === 'high' ? styles.widgetAlert : worst ? styles.widgetWarn : '';

    return (
        <div className={styles.widget}>
            <div className={styles.widgetStat}>
                <span className={`${styles.widgetValue} ${loading ? '' : tone}`}>{loading ? '—' : total}</span>
                <span className={styles.widgetLabel}>{total > 1 ? 'constats ouverts' : 'constat ouvert'}</span>
            </div>
            <span className={styles.widgetFoot}>
                {loading
                    ? 'Chargement…'
                    : watched === 0
                      ? 'Aucun appareil surveillé'
                      : open.critical > 0
                        ? `${open.critical} critique${open.critical > 1 ? 's' : ''} à examiner`
                        : open.high > 0
                          ? `${open.high} à vérifier`
                          : total > 0
                            ? `${watched} appareil${watched > 1 ? 's' : ''} surveillé${watched > 1 ? 's' : ''}`
                            : `Rien à signaler sur ${watched} appareil${watched > 1 ? 's' : ''}`}
            </span>
        </div>
    );
}

export default SentinelWidget;
