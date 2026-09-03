import type { AudienceResultField, AudienceResults } from '../../contracts/domain';

import { formatCount, formatPercent } from '../format';
import styles from '../style.module.css';

interface ResultsProps {
    results: AudienceResults;
}

/**
 * La répartition des réponses, question par question.
 *
 * Les comptes sont tenus à la réception : lire cet écran ne déchiffre rien
 * d'autre que les quelques dizaines de libellés affichés, quel que soit le
 * nombre de retours derrière.
 *
 * Une question dont les réponses sont des textes n'a rien à répartir : elle
 * annonce son nombre et renvoie au tableau, plutôt que de montrer une liste de
 * messages comptés à un chacun.
 */
export function Results({ results }: ResultsProps) {
    if (results.fields.length === 0) {
        return <p className={styles.empty}>Aucune réponse reçue pour l’instant.</p>;
    }

    return (
        <div className={styles.panels}>
            {results.fields.map((field) => (
                <Field key={field.name} field={field} />
            ))}
        </div>
    );
}

function Field({ field }: { field: AudienceResultField }) {
    // L'échelle est celle de la réponse en tête, comme les autres classements du
    // module : rapportée au total, une question à vingt choix serait plate.
    const max = Math.max(1, ...field.values.map((value) => value.count));
    const average = averageOf(field);

    return (
        <section className={styles.panel}>
            <div className={styles.panelHead}>
                <h3 className={styles.panelTitle}>{field.name}</h3>
                <span className={styles.resultCount}>
                    {formatCount(field.answered)} réponse{field.answered > 1 ? 's' : ''}
                    {average !== null && ` · moyenne ${average.toLocaleString('fr-FR', { maximumFractionDigits: 1 })}`}
                </span>
            </div>

            {field.values.length > 0 && (
                <ol className={styles.topList}>
                    {field.values.map((value) => (
                        <li key={value.label} className={styles.topRow}>
                            <span
                                className={styles.topBar}
                                style={{ width: `${(value.count / max) * 100}%` }}
                                aria-hidden='true'
                            />
                            <span className={styles.topLabel} title={value.label}>
                                {value.label}
                            </span>
                            <span className={styles.topValue}>
                                {formatCount(value.count)}
                                <span className={styles.topVisitors}>
                                    {formatPercent(value.count / field.answered)}
                                </span>
                            </span>
                        </li>
                    ))}
                </ol>
            )}

            {field.free > 0 && (
                <p className={styles.empty}>
                    {formatCount(field.free)} réponse{field.free > 1 ? 's' : ''} en texte libre, à lire dans le tableau.
                </p>
            )}
        </section>
    );
}

/**
 * La moyenne d'une question dont toutes les réponses sont des nombres (une
 * note, un âge). Calculée depuis la répartition, qui porte déjà les valeurs et
 * leurs comptes : rien à demander de plus au serveur.
 *
 * `null` dès qu'une réponse n'est pas un nombre, ou qu'il en reste en texte
 * libre : une moyenne sur un sous-ensemble non dit serait un chiffre faux.
 */
function averageOf(field: AudienceResultField): number | null {
    if (field.values.length === 0 || field.free > 0) return null;
    let total = 0;
    let count = 0;
    for (const value of field.values) {
        const parsed = Number(value.label.replace(',', '.'));
        if (!Number.isFinite(parsed)) return null;
        total += parsed * value.count;
        count += value.count;
    }
    return count > 0 ? total / count : null;
}

export default Results;
