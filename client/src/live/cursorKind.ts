import type { LiveCursorKind } from '@deveye/types';

/**
 * Ce que le navigateur dessine sous le pointeur, ramené aux sept familles que la
 * présence sait représenter. On lit le curseur effectif plutôt que de le déduire
 * de la nature de l'élément : c'est le CSS qui décide, et lui seul connaît les cas
 * que le balisage ne dit pas, tel un `<div>` rendu cliquable.
 */

/**
 * `getComputedStyle().cursor` peut valoir `url("…") 4 12, pointer` : le mot-clé
 * de repli est le dernier de la liste, et le seul que l'on sache dessiner.
 */
function keywordOf(css: string): string {
    const parts = css.split(',');
    return parts[parts.length - 1].trim().toLowerCase();
}

/**
 * `cursor: auto`, la valeur par défaut donc la plus répandue, n'est pas résolu par
 * `getComputedStyle`, qui rend le mot tel quel. Le navigateur, lui, l'arbitre à
 * l'affichage : barre de texte au-dessus de contenu sélectionnable, flèche
 * ailleurs. Refaire cet arbitrage est ce qui évite de montrer aux pairs une
 * flèche là où la personne d'en face voit une barre.
 */
function resolveAuto(el: Element): LiveCursorKind {
    if ((el as HTMLElement).isContentEditable) return 'text';
    if (el.tagName === 'TEXTAREA') return 'text';
    if (el.tagName === 'INPUT') {
        const type = (el as HTMLInputElement).type;
        return TEXTUAL_INPUTS.has(type) ? 'text' : 'default';
    }
    if (getComputedStyle(el).userSelect === 'none') return 'default';
    // Un nœud de texte direct et non vide : un conteneur qui ne fait qu'envelopper
    // d'autres éléments n'est pas survolé « sur du texte ».
    for (const node of el.childNodes) {
        if (node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== '') return 'text';
    }
    return 'default';
}

const TEXTUAL_INPUTS = new Set(['text', 'search', 'email', 'password', 'url', 'tel', 'number']);

function familyOf(keyword: string): LiveCursorKind {
    switch (keyword) {
        case 'pointer':
            return 'pointer';
        case 'text':
        case 'vertical-text':
            return 'text';
        case 'grab':
            return 'grab';
        case 'grabbing':
        case 'move':
        case 'all-scroll':
            return 'grabbing';
        case 'not-allowed':
        case 'no-drop':
            return 'blocked';
        default:
            // Les `*-resize` se dessinent tous pareil à cette taille : une double
            // flèche.
            return keyword.endsWith('-resize') ? 'resize' : 'default';
    }
}

/**
 * L'état du curseur à un point de l'écran. `buttonHeld` fait passer une main
 * ouverte à une main fermée : beaucoup d'interfaces déclarent `grab` sans jamais
 * basculer sur `grabbing`, et c'est pourtant l'instant où le geste se lit.
 */
export function cursorKindAt(clientX: number, clientY: number, buttonHeld: boolean): LiveCursorKind {
    const el = document.elementFromPoint(clientX, clientY);
    // Hors de la fenêtre : rien à interroger, on garde la flèche neutre.
    if (!el) return 'default';
    const keyword = keywordOf(getComputedStyle(el).cursor);
    const kind = keyword === 'auto' ? resolveAuto(el) : familyOf(keyword);
    if (buttonHeld && (kind === 'grab' || kind === 'default')) {
        return kind === 'grab' ? 'grabbing' : 'default';
    }
    return kind;
}
