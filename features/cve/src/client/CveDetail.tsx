import { safeHref, StatusBadge } from 'deveye-sdk-client';

import type { CveEntry } from '../contracts/domain';

import { useDetailAsPage } from './layout';
import { fullDate, referenceHost, referenceTag, SEVERITY_LABEL, severityTone } from './severity';
import styles from './style.module.css';

interface Props {
    entry: CveEntry;
    canWrite: boolean;
    onToggleFavorite: (entry: CveEntry) => void;
    onClose: () => void;
}

/** Le nombre de références montrées : au-delà, la liste devient un annuaire. */
const MAX_REFERENCES = 12;

/**
 * Une CVE en détail : ce qu'elle vaut, ce qu'elle dit, et où lire la suite.
 * Retour, titre et actions dans la rangée d'en-tête, comme partout ailleurs.
 */
export default function CveDetail({ entry, canWrite, onToggleFavorite, onClose }: Props) {
    const references = entry.references.slice(0, MAX_REFERENCES);
    // Pleine page, on revient à la liste ; à côté d'elle, on referme un panneau.
    const asPage = useDetailAsPage();

    return (
        <div className={styles.detail}>
            <header className={styles.detailHead}>
                <button
                    type='button'
                    className={styles.iconBtn}
                    onClick={onClose}
                    title={asPage ? 'Revenir à la liste' : 'Fermer la fiche'}
                    aria-label={asPage ? 'Revenir à la liste' : 'Fermer la fiche'}
                >
                    <span className={`icon ${asPage ? 'icon-arrow-left' : 'icon-x'}`} />
                </button>
                <h3 className={styles.detailTitle}>{entry.id}</h3>
                <button
                    type='button'
                    className={styles.iconBtn}
                    disabled={!canWrite}
                    title={
                        canWrite
                            ? entry.isFavorite
                                ? 'Retirer des épingles de l’espace'
                                : 'Épingler pour l’espace'
                            : 'Votre rôle ne permet pas d’épingler'
                    }
                    aria-pressed={entry.isFavorite}
                    onClick={() => onToggleFavorite(entry)}
                >
                    <span className={`icon ${entry.isFavorite ? 'icon-star' : 'icon-star-outline'}`} />
                </button>
                <a
                    className={styles.iconBtn}
                    href={`https://nvd.nist.gov/vuln/detail/${entry.id}`}
                    target='_blank'
                    rel='noreferrer'
                    title='Ouvrir la fiche du NVD'
                >
                    <span className='icon icon-move-to-right' />
                </a>
            </header>

            <div className={styles.detailMeta}>
                <StatusBadge tone={severityTone(entry.severity)}>
                    {entry.score === null
                        ? SEVERITY_LABEL[entry.severity]
                        : `${SEVERITY_LABEL[entry.severity]} ${entry.score.toFixed(1)}`}
                </StatusBadge>
                <span className={styles.detailDate}>Publiée le {fullDate(entry.published)}</span>
            </div>

            <p className={styles.detailSummary}>{entry.summary}</p>

            {(entry.vector || entry.cwe) && (
                <dl className={styles.detailFacts}>
                    {entry.cwe && (
                        <>
                            <dt>Faiblesse</dt>
                            <dd>{entry.cwe}</dd>
                        </>
                    )}
                    {entry.vector && (
                        <>
                            <dt>Vecteur CVSS</dt>
                            <dd className={styles.detailVector}>{entry.vector}</dd>
                        </>
                    )}
                </dl>
            )}

            {references.length > 0 && (
                <section className={styles.detailSection}>
                    <h4 className={styles.detailSectionTitle}>Références</h4>
                    <ul className={styles.refList}>
                        {references.map((ref) => (
                            <li key={ref.url} className={styles.refRow}>
                                <a
                                    className={styles.refLink}
                                    href={safeHref(ref.url)}
                                    target='_blank'
                                    rel='noreferrer'
                                    title={ref.url}
                                >
                                    {referenceHost(ref.url)}
                                </a>
                                {ref.tags.length > 0 && (
                                    <span className={styles.refTags}>
                                        {ref.tags.map((tag) => referenceTag(tag)).join(' · ')}
                                    </span>
                                )}
                            </li>
                        ))}
                    </ul>
                    {entry.references.length > references.length && (
                        <p className={styles.detailMore}>
                            et {entry.references.length - references.length} autres sur la fiche du NVD
                        </p>
                    )}
                </section>
            )}
        </div>
    );
}
