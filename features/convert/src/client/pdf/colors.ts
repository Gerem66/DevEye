/** La couleur qui désigne un fichier, parmi les huit du thème : jamais une valeur en dur, un jeton. */
const PALETTE = ['blue', 'green', 'orange', 'purple', 'pink', 'yellow', 'indigo', 'red'] as const;

export const sourceColorVar = (index: number): string => `var(--palette-${PALETTE[index % PALETTE.length]})`;
