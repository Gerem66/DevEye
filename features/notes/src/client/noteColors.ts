import type { NoteColor } from '../contracts/domain';

/**
 * The set of names is owned by `noteColorSchema` in @deveye/types; here they get
 * a French label and the swatch order. The colour value always comes from the
 * `--note-<name>` token (style.module.css), never a hex here.
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

export function colorVar(color: NoteColor): string {
    return `var(--note-${color})`;
}
