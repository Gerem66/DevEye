import type { ProjectMilestone, ProjectMilestoneColor } from '../contracts/domain';
import styles from './style.module.css';

/**
 * Ce qui donne sa teinte à un jalon, partout où il paraît : sa pastille sur la
 * frise, la puce de ses tâches, son entrée dans un sélecteur. Une variable du
 * thème et jamais un hexadécimal, comme la palette des Finances.
 */
export function milestoneColorVar(color: ProjectMilestoneColor): string {
    return `var(--palette-${color})`;
}

/** Le jalon d'une carte, ou `null` quand elle n'en a pas ou qu'il a disparu. */
export function milestoneOf(milestones: readonly ProjectMilestone[], id: number | null): ProjectMilestone | null {
    if (id === null) return null;
    return milestones.find((m) => m.id === id) ?? null;
}

/**
 * La pastille de couleur d'un jalon. Rendue même sans couleur, en creux : sans
 * elle, les entrées d'un sélecteur ne seraient pas alignées entre elles.
 */
export function MilestoneDot({ color }: { color: ProjectMilestoneColor | null }) {
    return (
        <span
            className={color === null ? styles.milestoneDotNone : styles.milestoneDot}
            style={color === null ? undefined : { background: milestoneColorVar(color) }}
            aria-hidden='true'
        />
    );
}
