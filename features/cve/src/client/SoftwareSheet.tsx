import { safeHref, StatusBadge } from 'deveye-sdk-client';

import type { Software } from '../contracts/software';

import { useDetailAsPage } from './layout';
import { askedSummary, categoryLabel, maintainedReleases, verdictLine } from './softwareLabels';
import SoftwareTable from './SoftwareTable';
import styles from './style.module.css';

/**
 * La fiche d'un logiciel trouvé par la recherche : ses branches et leurs dates.
 * Avec une seule branche demandée, le verdict d'abord, en une phrase.
 */
export default function SoftwareSheet({
    software,
    releases,
    onClose
}: {
    software: Software;
    releases: readonly string[];
    onClose: () => void;
}) {
    const asPage = useDetailAsPage();
    const link = safeHref(software.link);
    const { asked, badge } = askedSummary(software, releases);
    const category = categoryLabel(software.category);
    const maintained = maintainedReleases(software).length;

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
                <h3 className={styles.detailTitle}>{software.label}</h3>
                {link && (
                    <a
                        className={styles.iconBtn}
                        href={link}
                        target='_blank'
                        rel='noreferrer'
                        title='Voir sur endoflife.date'
                        aria-label='Voir sur endoflife.date'
                    >
                        <span className='icon icon-move-to-right' />
                    </a>
                )}
            </header>

            <div className={styles.detailMeta}>
                {releases.length > 0 && <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>}
                <span className={styles.detailDate}>
                    {category ? `${category} · ` : ''}
                    {software.releases.length} version{software.releases.length > 1 ? 's' : ''}, dont {maintained}{' '}
                    maintenue{maintained > 1 ? 's' : ''}
                </span>
            </div>

            {asked && <p className={styles.detailSummary}>{verdictLine(software, asked)}</p>}

            <SoftwareTable software={software} highlight={releases} />
        </div>
    );
}
