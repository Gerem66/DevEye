import { totalOpen, useSentinelCount, worstSeverity } from '@/stores/sentinel';

import styles from './style.module.css';

/**
 * Carte de grille de Sentinelle.
 *
 * Elle répond à une seule question : **à quel point**, et non « combien ». Un
 * grand nombre de constats mineurs est moins urgent qu'un seul constat critique,
 * donc c'est la pire gravité qui teinte la carte et qui décide du sous-titre.
 *
 * Un espace où Sentinelle n'est activée nulle part le dit explicitement, plutôt
 * que d'afficher un « 0 constat » rassurant qui ne reposerait sur rien : c'est
 * la même règle que partout dans cette feature — ne pas mesurer n'est pas aller
 * bien.
 */
export function SentinelWidget() {
    const { open, watched, loading } = useSentinelCount();
    const total = totalOpen(open);
    const worst = worstSeverity(open);

    const tone =
        worst === 'critical' || worst === 'high' ? styles.widgetAlert : worst ? styles.widgetWarn : styles.widgetCalm;

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
