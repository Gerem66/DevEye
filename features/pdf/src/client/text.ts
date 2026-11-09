/**
 * Le texte d'une page tel que pdf.js le livre : des fragments posés chacun
 * à une position. On les remet en lignes (même ligne de base), de haut en
 * bas et de gauche à droite, avec une espace là où deux fragments s'écartent.
 */

export interface TextFragment {
    str: string;
    /** La matrice du fragment : [4] et [5] sont son origine, dans le repère du fichier (y vers le haut). */
    transform: readonly number[];
    width: number;
    height: number;
    hasEOL: boolean;
}

interface Line {
    y: number;
    height: number;
    parts: { x: number; width: number; str: string }[];
}

/** Les fragments en lignes lisibles. Une page sans texte rend une chaîne vide. */
export function linesOf(fragments: readonly TextFragment[]): string {
    const lines: Line[] = [];
    for (const f of fragments) {
        if (f.str === '' && !f.hasEOL) continue;
        const x = f.transform[4] ?? 0;
        const y = f.transform[5] ?? 0;
        const height = Math.abs(f.height) || Math.abs(f.transform[3]) || 10;
        const line = lines.find((l) => Math.abs(l.y - y) <= Math.max(l.height, height) * 0.4);
        if (line) {
            line.parts.push({ x, width: f.width, str: f.str });
            line.height = Math.max(line.height, height);
        } else {
            lines.push({ y, height, parts: [{ x, width: f.width, str: f.str }] });
        }
    }
    lines.sort((a, b) => b.y - a.y);
    return lines
        .map((line) => {
            line.parts.sort((a, b) => a.x - b.x);
            let text = '';
            let end: number | null = null;
            for (const part of line.parts) {
                if (part.str === '') continue;
                // Un écart d'un tiers de la hauteur entre deux fragments : une espace que le fichier n'a pas écrite.
                if (
                    end !== null &&
                    part.x - end > line.height * 0.3 &&
                    !text.endsWith(' ') &&
                    !part.str.startsWith(' ')
                ) {
                    text += ' ';
                }
                text += part.str;
                end = part.x + part.width;
            }
            return text.replace(/\s+$/, '');
        })
        .filter((text, i, all) => text !== '' || (i > 0 && all[i - 1] !== ''))
        .join('\n')
        .trim();
}
