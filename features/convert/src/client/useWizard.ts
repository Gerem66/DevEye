import { useCallback, useReducer } from 'react';

import { detectSource, targetOf, targetsFor, type ConvertKind } from '../contracts/catalogue';
import type { OptionValue, OptionValues } from '../contracts/options';
import type { FileInfo } from './probe';

/**
 * L'état de l'assistant. Revenir en arrière ne perd rien : les réglages vivent
 * ici et non dans les étapes, et survivent à un changement de format dès qu'ils
 * portent le même nom (la qualité d'un MP4 reste celle du WebM choisi ensuite).
 */

export type WizardView = 'kinds' | 'format' | 'options' | 'export';

export interface WizardState {
    view: WizardView;
    kind: ConvertKind | null;
    file: File | null;
    info: FileInfo | null;
    sourceId: string | null;
    /** Ce que le nom du fichier a laissé reconnaître. Le choix reste libre : une extension peut mentir. */
    detectedSourceId: string | null;
    targetId: string | null;
    values: OptionValues;
}

type Action =
    | { type: 'open'; view: WizardView }
    | { type: 'pickKind'; kind: ConvertKind }
    | { type: 'pickFile'; file: File }
    | { type: 'removeFile' }
    | { type: 'info'; info: FileInfo }
    | { type: 'source'; sourceId: string }
    | { type: 'target'; targetId: string }
    | { type: 'value'; id: string; value: OptionValue }
    | { type: 'reset' };

const INITIAL: WizardState = {
    view: 'kinds',
    kind: null,
    file: null,
    info: null,
    sourceId: null,
    detectedSourceId: null,
    targetId: null,
    values: {}
};

/** La cible gardée si la nouvelle source l'accepte encore, la première possible sinon. */
function keepTarget(kind: ConvertKind, sourceId: string, targetId: string | null): string | null {
    if (targetId && targetOf(kind, sourceId, targetId)) return targetId;
    return targetsFor(kind, sourceId)[0]?.id ?? null;
}

function reduce(state: WizardState, action: Action): WizardState {
    switch (action.type) {
        case 'open':
            return { ...state, view: action.view };
        case 'pickKind':
            return action.kind === state.kind
                ? { ...state, view: 'format' }
                : { ...INITIAL, view: 'format', kind: action.kind, values: state.values };
        case 'pickFile': {
            const detected = detectSource(action.file.name);
            const kind = detected?.kind ?? state.kind;
            if (!kind) return state;
            const sameKind = kind === state.kind;
            const sourceId = detected?.source.id ?? (sameKind ? state.sourceId : null);
            return {
                ...state,
                view: 'format',
                kind,
                file: action.file,
                info: null,
                sourceId,
                detectedSourceId: detected?.source.id ?? null,
                targetId: sourceId ? keepTarget(kind, sourceId, sameKind ? state.targetId : null) : null
            };
        }
        case 'removeFile':
            return { ...INITIAL, view: 'format', kind: state.kind, values: state.values };
        case 'info':
            return { ...state, info: action.info };
        case 'source':
            return state.kind
                ? {
                      ...state,
                      sourceId: action.sourceId,
                      targetId: keepTarget(state.kind, action.sourceId, state.targetId)
                  }
                : state;
        case 'target':
            return { ...state, targetId: action.targetId };
        case 'value':
            return { ...state, values: { ...state.values, [action.id]: action.value } };
        case 'reset':
            return INITIAL;
    }
}

export function useWizard() {
    const [state, dispatch] = useReducer(reduce, INITIAL);
    return {
        state,
        open: useCallback((view: WizardView) => dispatch({ type: 'open', view }), []),
        pickKind: useCallback((kind: ConvertKind) => dispatch({ type: 'pickKind', kind }), []),
        pickFile: useCallback((file: File) => dispatch({ type: 'pickFile', file }), []),
        removeFile: useCallback(() => dispatch({ type: 'removeFile' }), []),
        setInfo: useCallback((info: FileInfo) => dispatch({ type: 'info', info }), []),
        setSource: useCallback((sourceId: string) => dispatch({ type: 'source', sourceId }), []),
        setTarget: useCallback((targetId: string) => dispatch({ type: 'target', targetId }), []),
        setValue: useCallback((id: string, value: OptionValue) => dispatch({ type: 'value', id, value }), []),
        reset: useCallback(() => dispatch({ type: 'reset' }), [])
    };
}

export type Wizard = ReturnType<typeof useWizard>;
