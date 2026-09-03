import { useSyncExternalStore } from 'react';

/**
 * Mode de rendu de l'interface. Le mode léger retire ce qui coûte un repaint de
 * grande surface à chaque frame (le verre, les flous plein écran, les ombres
 * larges) plutôt que le mouvement : sans compositing matériel, c'est la surface
 * repeinte qui fait décrocher, pas le nombre d'animations.
 *
 * Réglage propre à l'appareil, donc `localStorage` seul, sans clé par espace ni
 * synchronisation serveur : un même compte a de bonnes raisons d'être en complet
 * sur un poste et en léger sur un téléphone.
 */
export type RenderMode = 'auto' | 'full' | 'lite';
export type RenderVerdict = 'full' | 'lite';

const KEY = 'deveye:render';

/**
 * Le verdict de la sonde, mémorisé d'une session à l'autre : en `auto`, un
 * appareil lent démarre directement allégé au lieu de resubir les premières
 * secondes de mesure à chaque chargement.
 */
interface RenderState {
    mode: RenderMode;
    verdict: RenderVerdict | null;
}

const DEFAULT: RenderState = { mode: 'auto', verdict: null };

function read(): RenderState {
    try {
        const raw = localStorage.getItem(KEY);
        if (!raw) return DEFAULT;
        const p = JSON.parse(raw) as Partial<RenderState>;
        return {
            mode: p.mode === 'full' || p.mode === 'lite' || p.mode === 'auto' ? p.mode : 'auto',
            // Seul un verdict « léger » se reprend d'une session à l'autre. Un
            // « complet » se remesure : l'accélération matérielle se coupe, une
            // machine se charge, et la sonde ne coûte rien.
            verdict: p.verdict === 'lite' ? 'lite' : null
        };
    } catch {
        return DEFAULT;
    }
}

let state: RenderState = read();
const listeners = new Set<() => void>();

/**
 * Le signal normalisé pour « moins de transparence », que Safari et Chrome
 * exposent. Il dit exactement ce que le mode léger fait : on l'honore sans
 * attendre la mesure. `prefers-reduced-motion` reste distinct, il parle du
 * mouvement et n'implique pas d'alléger le rendu.
 */
const transparencyQuery =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-transparency: reduce)')
        : null;
let reducedTransparency = transparencyQuery?.matches ?? false;

function computeLite(s: RenderState): boolean {
    if (s.mode === 'lite') return true;
    if (s.mode === 'full') return false;
    return reducedTransparency || s.verdict === 'lite';
}

let lite = computeLite(state);

function applyRender(): void {
    if (typeof document === 'undefined') return;
    // Un attribut sur la racine plutôt qu'une classe : `theme.css` n'a qu'un bloc
    // à écrire, et les modules CSS peuvent le préfixer sans que leurs classes
    // cessent d'être hachées.
    if (lite) document.documentElement.dataset.render = 'lite';
    else delete document.documentElement.dataset.render;
}

/** Posé avant le premier rendu React, pour qu'aucune frame ne parte en verre. */
applyRender();

/** Recalcule le rendu effectif et le pose sur la racine, sans notifier. */
function refresh(): void {
    const next = computeLite(state);
    if (next === lite) return;
    lite = next;
    applyRender();
}

function notify(): void {
    for (const fn of listeners) fn();
}

transparencyQuery?.addEventListener('change', (e) => {
    reducedTransparency = e.matches;
    refresh();
    notify();
});

function persist(): void {
    try {
        localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
        // ignore (navigation privée, etc.)
    }
}

export function getRenderState(): RenderState {
    return state;
}

export function getLiteRender(): boolean {
    return lite;
}

export function setRenderMode(mode: RenderMode): void {
    if (mode === state.mode) return;
    state = { ...state, mode };
    persist();
    refresh();
    notify();
}

/** La sonde n'a de sens qu'en `auto`, et seulement tant qu'aucun verdict n'est tombé. */
export function shouldProbe(): boolean {
    return state.mode === 'auto' && state.verdict === null;
}

/**
 * Verdict de la sonde. Collant : une fois en léger, `auto` y reste, mesurer une
 * interface déjà allégée ne pourrait que la confirmer. Le mode « Complet » est
 * le recours pour qui n'est pas d'accord.
 */
export function recordVerdict(v: RenderVerdict): void {
    if (state.verdict === v) return;
    state = { ...state, verdict: v };
    persist();
    refresh();
    notify();
}

function subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
}

export function useRenderState(): RenderState {
    return useSyncExternalStore(subscribe, getRenderState, getRenderState);
}

export function useLiteRender(): boolean {
    return useSyncExternalStore(subscribe, getLiteRender, getLiteRender);
}
