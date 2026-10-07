import type { MinimalUser } from '@deveye/types';
import type { ProjectCard } from '../../contracts/domain';

/** Minuscules et sans accents : « tache » trouve « Tâche ». */
function fold(text: string): string {
    return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/**
 * Le filtre de la recherche du tableau ; `null` quand elle est vide. Chaque mot
 * doit paraître quelque part dans la tâche : titre, description, sous-tâches, ou
 * nom de qui porte la tâche ou l'une de ses sous-tâches. Un membre hors de
 * l'espace actif n'est pas nommé ici, il ne se trouve donc pas non plus.
 */
export function cardSearch(query: string, members: readonly MinimalUser[]): ((card: ProjectCard) => boolean) | null {
    const words = fold(query).split(/\s+/).filter(Boolean);
    if (words.length === 0) return null;
    const names = new Map(members.map((m) => [m.id, fold(m.username)]));
    return (card) => {
        const people = [card.assigneeUserId, ...card.checklist.map((i) => i.assigneeUserId)];
        const text = [
            fold(card.title),
            fold(card.description),
            ...card.checklist.map((i) => fold(i.label)),
            ...people.map((id) => (id === null ? '' : (names.get(id) ?? '')))
        ].join('\n');
        return words.every((w) => text.includes(w));
    };
}

/**
 * L'ordre complet d'une colonne après un glissé, d'après celui de ses cartes
 * visibles : une tâche masquée par la recherche ne bouge pas. Seule `moved`
 * change de place, posée juste après sa voisine visible du dessus, ou juste
 * avant celle du dessous quand elle arrive en tête.
 */
export function orderWithHidden(column: readonly number[], visible: readonly number[], moved: number): number[] {
    const rest = column.filter((id) => id !== moved);
    const at = visible.indexOf(moved);
    const above = visible[at - 1];
    const below = visible[at + 1];
    const index =
        above !== undefined ? rest.indexOf(above) + 1 : below !== undefined ? rest.indexOf(below) : rest.length;
    rest.splice(index, 0, moved);
    return rest;
}
