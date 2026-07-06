import type { NoteColor } from 'deveye-types';

/**
 * The Notes colour palette, UI side. The set of names is owned by
 * `noteColorSchema` in deveye-types; here we attach a French label and the
 * order shown in the swatch pickers. The actual colour value always comes from
 * the `--note-<name>` theme token (see Styles/theme.css) — never a hex here, so
 * the palette stays a single design-token source.
 */
export interface NoteColorOption {
    value: NoteColor;
    label: string;
}

export const NOTE_COLOR_OPTIONS: NoteColorOption[] = [
    { value: 'red', label: 'Rouge' },
    { value: 'orange', label: 'Orange' },
    { value: 'yellow', label: 'Jaune' },
    { value: 'green', label: 'Vert' },
    { value: 'blue', label: 'Bleu' },
    { value: 'purple', label: 'Violet' }
];

/** CSS value tinting to a palette colour, via its theme token. */
export function colorVar(color: NoteColor): string {
    return `var(--note-${color})`;
}
