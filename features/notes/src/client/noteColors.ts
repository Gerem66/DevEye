import type { NoteColor } from '../contracts/domain';

/**
 * The Notes colour palette, UI side. The set of names is owned by
 * `noteColorSchema` in @deveye/types; here we attach a French label and the
 * order shown in the swatch pickers. The actual colour value always comes from
 * the `--note-<name>` palette token, declared by this module's own stylesheet
 * (style.module.css, on `:root`): never a hex here, so the palette stays a
 * single source. Not the app theme: the names are the user's choices, owned by
 * the feature, and the app has no light theme to give them a variant.
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

/** CSS value tinting to a palette colour, via its palette token. */
export function colorVar(color: NoteColor): string {
    return `var(--note-${color})`;
}
