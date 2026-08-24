import type { UserColor } from '@deveye/types';

/**
 * La palette d'identité des comptes, côté interface. L'ensemble des noms est
 * détenu par `userColorSchema` dans @deveye/types ; on y attache ici une
 * étiquette française et l'ordre du sélecteur. La valeur vient toujours du jeton
 * `--user-<nom>` (voir Styles/theme.css) — jamais un hexadécimal ici, pour que
 * la palette reste une source de vérité unique.
 *
 * Même contrat que `Features/Notes/noteColors.ts`, dont ceci est le pendant.
 */
export interface UserColorOption {
    value: UserColor;
    label: string;
}

export const USER_COLOR_OPTIONS: UserColorOption[] = [
    { value: 'red', label: 'Rouge' },
    { value: 'orange', label: 'Orange' },
    { value: 'yellow', label: 'Jaune' },
    { value: 'green', label: 'Vert' },
    { value: 'blue', label: 'Bleu' },
    { value: 'indigo', label: 'Indigo' },
    { value: 'purple', label: 'Violet' },
    { value: 'pink', label: 'Rose' }
];

/** Valeur CSS teintant à une couleur de compte, via son jeton de thème. */
export function userColorVar(color: UserColor): string {
    return `var(--user-${color})`;
}
