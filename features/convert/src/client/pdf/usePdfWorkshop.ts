import { useCallback, useMemo, useReducer } from 'react';

import {
    addImage,
    addSource,
    duplicatePages,
    EMPTY_PLAN,
    insertBlank,
    keepPages,
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
 * L'état de l'atelier : le plan, la sélection, et l'historique du plan pour
 * annuler et rétablir. La sélection n'entre pas dans l'historique, elle se
 * taille au plan courant.
 */

interface State {
    plan: Plan;
    selection: readonly string[];
    /** La dernière page cliquée seule : d'où part une sélection à la touche Maj. */
    anchor: string | null;
    past: readonly Plan[];
    future: readonly Plan[];
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
    | { type: 'undo' }
    | { type: 'redo' };

const HISTORY_MAX = 100;

const INITIAL: State = { plan: EMPTY_PLAN, selection: [], anchor: null, past: [], future: [] };

const prune = (selection: readonly string[], plan: Plan): string[] => {
    const present = new Set(plan.pages.map((p) => p.id));
    return selection.filter((id) => present.has(id));
};

/** Un nouveau plan entre dans l'historique ; un plan identique ne fait rien. */
function commit(state: State, plan: Plan, selection: readonly string[] = state.selection): State {
    if (plan === state.plan) return state;
    return {
        plan,
        selection: prune(selection, plan),
        anchor: state.anchor !== null && plan.pages.some((p) => p.id === state.anchor) ? state.anchor : null,
        past: [...state.past.slice(-(HISTORY_MAX - 1)), state.plan],
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
            return commit(state, removePages(state.plan, action.ids), []);
        case 'keep':
            return commit(state, keepPages(state.plan, action.ids));
        case 'rotate':
            return commit(state, rotatePages(state.plan, action.ids, action.delta));
        case 'duplicate': {
            const { plan, created } = duplicatePages(state.plan, action.ids);
            return commit(state, plan, created);
        }
        case 'blank': {
            const { plan, id } = insertBlank(state.plan, action.afterId);
            return { ...commit(state, plan, [id]), anchor: id };
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
        case 'undo': {
            const previous = state.past.at(-1);
            if (!previous) return state;
            return {
                plan: previous,
                selection: prune(state.selection, previous),
                anchor: null,
                past: state.past.slice(0, -1),
                future: [state.plan, ...state.future]
            };
        }
        case 'redo': {
            const [next, ...rest] = state.future;
            if (!next) return state;
            return {
                plan: next,
                selection: prune(state.selection, next),
                anchor: null,
                past: [...state.past, state.plan],
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
