import { sourceOf, type Plan, type PlanPage } from './model';
import { parseRanges } from './ranges';

/**
 * Un document découpé en plusieurs : par fichier d'origine, toutes les N
 * pages, ou selon des plages écrites. Chaque partie sait son rang dans
 * l'ensemble, pour que la numérotation continue.
 */

export type SplitMode = { kind: 'files' } | { kind: 'every'; count: number } | { kind: 'ranges'; text: string };

export interface SplitPart {
    label: string;
    pages: PlanPage[];
    /** Le rang de la première page dans le plan entier. */
    offset: number;
}

const stem = (name: string): string => name.replace(/\.[^.]+$/, '');

/** Les parties, ou `null` quand le mode ne se lit pas (une plage fausse, zéro page par partie). */
export function splitParts(plan: Plan, mode: SplitMode): SplitPart[] | null {
    const pages = plan.pages;
    if (pages.length === 0) return null;
    switch (mode.kind) {
        case 'files': {
            // Une page blanche ou une image suit le fichier de la page qui la précède.
            const parts: SplitPart[] = [];
            let current: SplitPart | null = null;
            let currentSource: string | null = null;
            for (const [i, page] of pages.entries()) {
                const sourceId: string | null = page.kind === 'source' ? page.sourceId : currentSource;
                if (!current || sourceId !== currentSource) {
                    const name = sourceId ? sourceOf(plan, sourceId)?.name : undefined;
                    current = { label: name ? stem(name) : `partie ${parts.length + 1}`, pages: [], offset: i };
                    currentSource = sourceId;
                    parts.push(current);
                }
                current.pages.push(page);
            }
            return parts;
        }
        case 'every': {
            if (!Number.isInteger(mode.count) || mode.count < 1) return null;
            const parts: SplitPart[] = [];
            for (let i = 0; i < pages.length; i += mode.count) {
                parts.push({
                    label: `pages ${i + 1}-${Math.min(i + mode.count, pages.length)}`,
                    pages: pages.slice(i, i + mode.count),
                    offset: i
                });
            }
            return parts;
        }
        case 'ranges': {
            const parts: SplitPart[] = [];
            for (const piece of mode.text.split(/[;|]/)) {
                if (piece.trim() === '') continue;
                const indices = parseRanges(piece, pages.length);
                if (!indices) return null;
                parts.push({
                    label: piece.trim().replace(/\s+/g, ''),
                    pages: indices.map((i) => pages[i]),
                    offset: indices[0]
                });
            }
            return parts.length > 0 ? parts : null;
        }
    }
}
