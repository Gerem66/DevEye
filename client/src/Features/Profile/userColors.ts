import type { UserColor } from '@deveye/types';

/**
 * La palette d'identité des comptes : les noms viennent de `userColorSchema`,
 * ceci n'ajoute que l'étiquette et l'ordre du sélecteur. La valeur passe
 * toujours par le jeton `--user-<nom>`, jamais un hexadécimal ici.
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
