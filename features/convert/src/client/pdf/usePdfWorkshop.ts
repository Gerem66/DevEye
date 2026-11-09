import { useCallback, useMemo, useReducer } from 'react';

import { rotateRect, type PdfElement } from './elements';
import {
    addImage,
    addSource,
    displayedSize,
    duplicatePages,
    EMPTY_PLAN,
    insertBlank,
    keepPages,
    newId,
    pagesBetween,
    removePages,
    removeSource,
    reorderPages,
    reorderSources,
    rotatePages,
    type ImageInfo,
    type Plan,
    type SourceInfo
} from './model';

/**
 * L'état de l'atelier : le plan des pages, ce qui est posé dessus, la
 * sélection, et l'historique pour annuler et rétablir. La sélection n'entre
 * pas dans l'historique, elle se taille au document courant.
 */

/** Ce que l'historique garde : les pages et ce qui est posé dessus. */
interface Snapshot {
    plan: Plan;
    elements: readonly PdfElement[];
}

interface State extends Snapshot {
    selection: readonly string[];
    /** La dernière page cliquée seule : d'où part une sélection à la touche Maj. */
    anchor: string | null;
    past: readonly Snapshot[];
    future: readonly Snapshot[];
}

/** Un fichier ouvert, PDF ou image, dans l'ordre où il a été déposé. */
export type OpenedFile = { kind: 'source'; source: SourceInfo } | { kind: 'image'; image: ImageInfo };

type Action =
    | { type: 'addFiles'; files: readonly OpenedFile[]; at?: number }
    | { type: 'removeSource'; id: string }
    | { type: 'reorderSources'; order: readonly string[] }
    | { type: 'reorder'; order: readonly string[] }
    | { type: 'remove'; ids: readonly string[] }
    | { type: 'keep'; ids: readonly string[] }
    | { type: 'rotate'; ids: readonly string[]; delta: 90 | -90 | 180 }
    | { type: 'duplicate'; ids: readonly string[] }
    | { type: 'blank'; afterId: string | null }
    | { type: 'select'; ids: readonly string[]; anchor?: string | null }
    | { type: 'toggle'; id: string }
    | { type: 'extend'; id: string }
    | { type: 'addElement'; element: PdfElement }
    | { type: 'updateElement'; id: string; patch: Partial<PdfElement> }
    | { type: 'removeElement'; id: string }
    | { type: 'undo' }
    | { type: 'redo' };

const HISTORY_MAX = 100;

const INITIAL: State = { plan: EMPTY_PLAN, elements: [], selection: [], anchor: null, past: [], future: [] };

const prune = (selection: readonly string[], plan: Plan): string[] => {
    const present = new Set(plan.pages.map((p) => p.id));
    return selection.filter((id) => present.has(id));
};

/** Les éléments dont la page existe encore. */
const onPages = (elements: readonly PdfElement[], plan: Plan): readonly PdfElement[] => {
    const present = new Set(plan.pages.map((p) => p.id));
    const kept = elements.filter((e) => present.has(e.pageId));
    return kept.length === elements.length ? elements : kept;
};

/** Un nouveau document entre dans l'historique ; un document identique ne fait rien. */
function commit(
    state: State,
    plan: Plan,
    elements: readonly PdfElement[] = state.elements,
    selection: readonly string[] = state.selection
): State {
    const next = onPages(elements, plan);
    if (plan === state.plan && next === state.elements) return state;
    return {
        plan,
        elements: next,
        selection: prune(selection, plan),
        anchor: state.anchor !== null && plan.pages.some((p) => p.id === state.anchor) ? state.anchor : null,
        past: [...state.past.slice(-(HISTORY_MAX - 1)), { plan: state.plan, elements: state.elements }],
        future: []
    };
}

function reduce(state: State, action: Action): State {
    switch (action.type) {
        case 'addFiles': {
            let plan = state.plan;
            let at = action.at;
            for (const file of action.files) {
                const added = file.kind === 'source' ? file.source.pages.length : 1;
                plan = file.kind === 'source' ? addSource(plan, file.source, at) : addImage(plan, file.image, at);
                if (at !== undefined) at += added;
            }
            return commit(state, plan);
        }
        case 'removeSource':
            return commit(state, removeSource(state.plan, action.id));
        case 'reorderSources':
            return commit(state, reorderSources(state.plan, action.order));
        case 'reorder':
            return commit(state, reorderPages(state.plan, action.order));
        case 'remove':
            return commit(state, removePages(state.plan, action.ids), state.elements, []);
        case 'keep':
            return commit(state, keepPages(state.plan, action.ids));
        case 'rotate': {
            // Ce qui est posé sur une page qui tourne la suit, et se lit toujours droit.
            const chosen = new Set(action.ids);
            const elements = state.elements.map((e) => {
                const page = chosen.has(e.pageId) ? state.plan.pages.find((p) => p.id === e.pageId) : undefined;
                if (!page) return e;
                return { ...e, ...rotateRect(e, displayedSize(page, state.plan), action.delta) };
            });
            return commit(state, rotatePages(state.plan, action.ids, action.delta), elements);
        }
        case 'duplicate': {
            const { plan, created } = duplicatePages(state.plan, action.ids);
            // Une page dupliquée emporte ce qui est posé dessus.
            const copies = action.ids.flatMap((id, i) =>
                state.elements.filter((e) => e.pageId === id).map((e) => ({ ...e, id: newId(), pageId: created[i] }))
            );
            return commit(state, plan, [...state.elements, ...copies], created);
        }
        case 'blank': {
            const { plan, id } = insertBlank(state.plan, action.afterId);
            return { ...commit(state, plan, state.elements, [id]), anchor: id };
        }
        case 'select':
            return {
                ...state,
                selection: prune(action.ids, state.plan),
                anchor: action.anchor === undefined ? (action.ids[0] ?? null) : action.anchor
            };
        case 'toggle': {
            const has = state.selection.includes(action.id);
            return {
                ...state,
                selection: has ? state.selection.filter((id) => id !== action.id) : [...state.selection, action.id],
                anchor: action.id
            };
        }
        case 'extend': {
            const anchor = state.anchor ?? action.id;
            const range = pagesBetween(state.plan, anchor, action.id);
            return { ...state, selection: [...new Set([...state.selection, ...range])] };
        }
        case 'addElement':
            return commit(state, state.plan, [...state.elements, action.element]);
        case 'updateElement': {
            const elements = state.elements.map((e) =>
                e.id === action.id ? ({ ...e, ...action.patch } as PdfElement) : e
            );
            return commit(state, state.plan, elements);
        }
        case 'removeElement':
            return commit(
                state,
                state.plan,
                state.elements.filter((e) => e.id !== action.id)
            );
        case 'undo': {
            const previous = state.past.at(-1);
            if (!previous) return state;
            return {
                ...previous,
                selection: prune(state.selection, previous.plan),
                anchor: null,
                past: state.past.slice(0, -1),
                future: [{ plan: state.plan, elements: state.elements }, ...state.future]
            };
        }
        case 'redo': {
            const [next, ...rest] = state.future;
            if (!next) return state;
            return {
                ...next,
                selection: prune(state.selection, next.plan),
                anchor: null,
                past: [...state.past, { plan: state.plan, elements: state.elements }],
                future: rest
            };
        }
    }
}

export function usePdfWorkshop() {
    const [state, dispatch] = useReducer(reduce, INITIAL);
    const act = useCallback(
        <T extends Action['type']>(type: T, payload: Omit<Extract<Action, { type: T }>, 'type'>) => {
            dispatch({ type, ...payload } as Action);
        },
        []
    );
    return useMemo(
        () => ({
            plan: state.plan,
            elements: state.elements,
            selection: state.selection,
            canUndo: state.past.length > 0,
            canRedo: state.future.length > 0,
            act,
            undo: () => dispatch({ type: 'undo' }),
            redo: () => dispatch({ type: 'redo' })
        }),
        [state, act]
    );
}

export type Workshop = ReturnType<typeof usePdfWorkshop>;
