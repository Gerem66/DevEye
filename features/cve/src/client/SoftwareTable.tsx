import { useMemo, useState } from 'react';
import { safeHref, StatusBadge } from 'deveye-sdk-client';

import type { Software, SoftwareRelease } from '../contracts/software';

import { fullDate } from './severity';
import {
    RELEASE_STATE_LABEL,
    releaseCodename,
    releaseLabel,
    releaseState,
    shortDate,
    type ReleaseState
} from './softwareLabels';
import styles from './style.module.css';

/** Les branches plus anciennes montrées d'office, en plus des maintenues : au-delà, le tableau devient une archive. */
const OLDER_SHOWN = 6;

const STATE_TONE: Record<ReleaseState, 'success' | 'warning' | 'neutral'> = {
    maintained: 'success',
    soon: 'warning',
    eol: 'neutral'
};

function eolCell(r: SoftwareRelease): string {
    if (r.eolFrom !== null) return shortDate(r.eolFrom);
    return r.isEol ? 'atteinte' : 'non annoncée';
}

/**
 * Les branches d'un logiciel et leurs dates. `highlight` : les branches que
 * l'espace fait tourner ou que la recherche demande, surlignées et toujours
 * montrées, même anciennes. Les colonnes se replient avec la largeur du conteneur, pas de la
 * fenêtre : le même tableau vit dans le panneau étroit et en pleine page.
 */
export default function SoftwareTable({
    software,
    highlight = []
}: {
    software: Software;
    highlight?: readonly string[];
}) {
    const [all, setAll] = useState(false);
    const asked = useMemo(() => new Set(highlight), [highlight]);
    const shown = useMemo(() => {
        if (all) return software.releases;
        let older = 0;
        return software.releases.filter((r) => {
            if (asked.has(r.name) || releaseState(r) !== 'eol') return true;
            return older++ < OLDER_SHOWN;
        });
    }, [all, software.releases, asked]);
    const hidden = software.releases.length - shown.length;

    return (
        <div className={styles.releaseTableWrap}>
            <table className={styles.releaseTable}>
                <thead>
                    <tr>
                        <th scope='col'>Version</th>
                        <th scope='col' className={styles.colRelease}>
                            Sortie
                        </th>
                        {software.hasEoas && (
                            <th
                                scope='col'
                                className={styles.colEoas}
                                title='Après cette date, seulement les correctifs de sécurité'
                            >
                                Support actif
                            </th>
                        )}
                        <th scope='col' title='Après cette date, plus aucun correctif, même de sécurité'>
                            Fin de vie
                        </th>
                        {software.hasEoes && (
                            <th
                                scope='col'
                                className={styles.colEoes}
                                title='Un support prolongé, souvent payant, chez l’éditeur ou un tiers'
                            >
                                Support étendu
                            </th>
                        )}
                        <th scope='col'>Dernière</th>
                    </tr>
                </thead>
                <tbody>
                    {shown.map((r) => {
                        const state = releaseState(r);
                        const isAsked = asked.has(r.name);
                        return (
                            <tr key={r.name} className={isAsked ? styles.releaseAsked : undefined}>
                                <td>
                                    <span className={styles.releaseCell}>
                                        <span className={styles.releaseName} title={releaseCodename(r)}>
                                            {releaseLabel(r)}
                                            {r.isLts && <span className={styles.componentTag}>LTS</span>}
                                        </span>
                                        <StatusBadge tone={isAsked && state === 'eol' ? 'danger' : STATE_TONE[state]}>
                                            {RELEASE_STATE_LABEL[state]}
                                        </StatusBadge>
                                    </span>
                                </td>
                                <td className={styles.colRelease}>{shortDate(r.releaseDate)}</td>
                                {software.hasEoas && <td className={styles.colEoas}>{shortDate(r.eoasFrom)}</td>}
                                <td>{eolCell(r)}</td>
                                {software.hasEoes && <td className={styles.colEoes}>{shortDate(r.eoesFrom)}</td>}
                                <td
                                    className={styles.releaseLatest}
                                    title={r.latestDate ? `Publiée le ${shortDate(r.latestDate)}` : undefined}
                                >
                                    {r.latest ?? ''}
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
            {hidden > 0 && (
                <button type='button' className={`${styles.linkBtn} ${styles.moreBtn}`} onClick={() => setAll(true)}>
                    Afficher les {hidden} versions plus anciennes
                </button>
            )}
            <p className={styles.detailMore}>
                Données{' '}
                <a
                    className={styles.refLink}
                    href={safeHref(software.link) ?? 'https://endoflife.date'}
                    target='_blank'
                    rel='noreferrer'
                >
                    endoflife.date
                </a>
                , relues le {fullDate(software.fetchedAt)}.
            </p>
        </div>
    );
}
