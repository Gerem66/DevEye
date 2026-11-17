import type { ReactNode } from 'react';

import { since } from './exposureLabels';
import styles from './style.module.css';
import type { Findings, StateFilter } from './useFindings';

const STATE_FILTERS: readonly { value: StateFilter; label: string }[] = [
    { value: 'open', label: 'À traiter' },
    { value: 'ignored', label: 'Ignorés' },
    { value: 'resolved', label: 'Résolus' }
];

/** Les filtres d'une liste de constats : l'état à gauche, `children` (la gravité) à droite, les projets dessous. */
export default function FindingFilters({ findings, children }: { findings: Findings; children?: ReactNode }) {
    const { state, setState, project, setProject, projects, loading, scannedAt, notices } = findings;
    return (
        <div className={styles.listTools}>
            <div className={styles.filters}>
                <div className={styles.severityChips} role='group' aria-label='Filtrer par état'>
                    {STATE_FILTERS.map((f) => (
                        <button
                            key={f.value}
                            type='button'
                            className={`${styles.chip} ${f.value === state ? styles.chipActive : ''}`}
                            aria-pressed={f.value === state}
                            onClick={() => setState(f.value)}
                        >
                            {f.label}
                        </button>
                    ))}
                </div>
                {children}
            </div>
            {projects.length > 0 && (
                <div className={styles.severityChips} role='group' aria-label='Filtrer par projet'>
                    <button
                        type='button'
                        className={`${styles.chip} ${project === null ? styles.chipActive : ''}`}
                        aria-pressed={project === null}
                        onClick={() => setProject(null)}
                    >
                        Tous les projets
                    </button>
                    {projects.map(([id, title]) => (
                        <button
                            key={id}
                            type='button'
                            className={`${styles.chip} ${project === id ? styles.chipActive : ''}`}
                            aria-pressed={project === id}
                            onClick={() => setProject(id)}
                        >
                            {title}
                        </button>
                    ))}
                </div>
            )}
            <p className={styles.status}>
                {loading
                    ? 'Chargement…'
                    : scannedAt === null
                      ? 'Rien n’a encore été analysé.'
                      : `Dernière lecture ${since(scannedAt)}.`}
            </p>
            {notices.map((n) => (
                <p key={n} className={styles.notice}>
                    <span className={`icon icon-warning ${styles.noticeIcon}`} aria-hidden='true' />
                    {n} Les constats d’avant restent affichés.
                </p>
            ))}
        </div>
    );
}

/** Ce que dit une liste vide, selon ce qui la vide. `openEmpty` : rien à traiter dans ce genre. */
export function emptyFindingsLine(findings: Findings, openEmpty: string): string {
    if (findings.scannedAt === null) {
        return 'La veille lit les dépôts, les appareils, les bases et les déploiements de l’espace : un élément ajouté est analysé dans les minutes qui suivent.';
    }
    if (findings.state === 'open') return openEmpty;
    if (findings.state === 'ignored') return 'Aucun constat ignoré.';
    return 'Rien de résolu ces trente derniers jours.';
}
