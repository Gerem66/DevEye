/**
 * Passage entre l'accueil et son organisation. Ce sont deux arbres distincts,
 * et l'organisation agrandit les sections (en-têtes, blocs d'ajout) : sans
 * transition, la page saute et l'on ne sait plus où l'on était. Chaque élément
 * marqué `data-morph` part de la place de son homologue et rejoint la sienne.
 */

const DURATION_MS = 380;
const EASING = 'cubic-bezier(0.32, 0.72, 0, 1)';

let pending: { editing: boolean; rects: Map<string, DOMRect> } | null = null;

function targets(root: HTMLElement): HTMLElement[] {
    return Array.from(root.querySelectorAll<HTMLElement>('[data-morph]'));
}

/** Mesure l'accueil affiché, juste avant de basculer vers `editing`. */
export function captureMorph(root: HTMLElement | null, editing: boolean): void {
    if (!root) return;
    const rects = new Map<string, DOMRect>();
    for (const el of targets(root)) rects.set(el.dataset.morph ?? '', el.getBoundingClientRect());
    pending = { editing, rects };
}

/** Le plus petit corps d'un élément : son rembourrage et sa bordure, que `height: 0` ne retire pas. */
function minBox(el: HTMLElement): number {
    const s = getComputedStyle(el);
    return (
        parseFloat(s.paddingTop) +
        parseFloat(s.paddingBottom) +
        parseFloat(s.borderTopWidth) +
        parseFloat(s.borderBottomWidth)
    );
}

/**
 * Joue la capture sur l'arbre qui vient d'être posé : à appeler depuis un effet
 * de layout, avant la première peinture. Une capture faite pour l'autre mode
 * (bascule abandonnée) est jetée.
 */
export function playMorph(root: HTMLElement | null, editing: boolean, reduced: boolean): void {
    const capture = pending;
    pending = null;
    if (!root || !capture || capture.editing !== editing || reduced) return;

    const els = targets(root);
    const finals = els.map((el) => el.getBoundingClientRect());
    // `main` défile : son ancrage natif corrigerait le défilement à chaque image
    // où une section au-dessus change de hauteur.
    const scroller = root.parentElement;
    if (scroller) scroller.style.overflowAnchor = 'none';

    // Les hauteurs s'animent pour de vrai : chaque élément descend déjà de ce que
    // les précédents n'ont pas encore pris. La translation ne porte que le reste
    // (écarts entre éléments, éléments apparus ou disparus).
    let shift = 0;
    const running: Animation[] = [];
    els.forEach((el, i) => {
        const to = finals[i];
        const from = capture.rects.get(el.dataset.morph ?? '');
        const fromHeight = from ? from.height : minBox(el);
        const dy = from ? from.top - to.top - shift : 0;
        shift += fromHeight - to.height;
        if (from && Math.abs(dy) < 0.5 && Math.abs(fromHeight - to.height) < 0.5) return;

        el.style.overflow = 'hidden';
        const animation = el.animate(
            [
                {
                    transform: `translateY(${dy}px)`,
                    height: `${fromHeight}px`,
                    minHeight: '0px',
                    opacity: from ? 1 : 0
                },
                { transform: 'none', height: `${to.height}px`, minHeight: '0px', opacity: 1 }
            ],
            { duration: DURATION_MS, easing: EASING }
        );
        const release = () => {
            el.style.overflow = '';
        };
        animation.onfinish = release;
        animation.oncancel = release;
        running.push(animation);
    });

    if (scroller) {
        void Promise.allSettled(running.map((a) => a.finished)).then(() => {
            scroller.style.overflowAnchor = '';
        });
    }
}
