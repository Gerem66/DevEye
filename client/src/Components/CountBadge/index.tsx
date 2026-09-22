import styles from './style.module.css';

export interface CountBadgeProps {
    /** Le nombre montré. Au-delà de `max`, la pastille dit « 99+ ». */
    count: number;
    /**
     * `accent` : ce qui réclame d'être vu, des messages non lus. `neutral` : ce qui
     * se compte sans rien demander, le contenu d'un onglet.
     */
    tone?: 'accent' | 'neutral';
    max?: number;
    /** Nécessaire quand le chiffre seul ne dit pas de quoi il est le compte. */
    'aria-label'?: string;
    className?: string;
}

/**
 * La pastille d'un compteur : un chiffre dans un rond. Ronde à un chiffre, elle
 * s'allonge en gélule au-delà, et son contenu est centré dans les deux sens, ce
 * qu'un simple retrait ne donne pas.
 */
export function CountBadge({ count, tone = 'accent', max = 99, className, ...aria }: CountBadgeProps) {
    return (
        <span className={`${styles.badge} ${className ?? ''}`} data-tone={tone} aria-label={aria['aria-label']}>
            {count > max ? `${max}+` : count}
        </span>
    );
}

export default CountBadge;
