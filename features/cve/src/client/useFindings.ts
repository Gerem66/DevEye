import { useCallback, useEffect, useMemo, useState } from 'react';
import { invalidate, useResource, useSubView, type ErrorNoteInput } from 'deveye-sdk-client';

import type { ExposureFinding, FindingKind } from '../contracts/exposure';

import { api } from './api';
import { cveError } from './errors';

/** Ce que la liste montre : ce qui demande une décision, ce qui en a reçu une, ce qui est réglé. */
export type StateFilter = 'open' | 'ignored' | 'resolved';

/**
 * Les constats de ces genres, filtrés par état et par projet, la fiche ouverte
 * et les gestes qu'elle porte. `kinds` doit garder son identité d'un rendu à
 * l'autre : une constante du module.
 */
export function useFindings(kinds: readonly FindingKind[], onDetailChange: (open: boolean) => void) {
    const [state, setState] = useState<StateFilter>('open');
    const [project, setProject] = useState<number | null>(null);
    const [selectedId, setSelectedId] = useState<number | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<ErrorNoteInput | null>(null);

    const view = state === 'resolved' ? 'resolved' : 'active';
    const exposure = useResource(
        'cve.exposure',
        () => api.send('cve.exposure', { view }),
        'Les constats n’ont pas pu être lus.',
        [view]
    );
    const inState = useMemo(
        () => (exposure.data?.findings ?? []).filter((f) => f.state === state && kinds.includes(f.kind)),
        [exposure.data, state, kinds]
    );
    const projects = useMemo(() => {
        const all = new Map<number, string>();
        for (const f of inState) for (const a of f.affected) for (const p of a.projects) all.set(p.id, p.title);
        return [...all].sort((a, b) => a[1].localeCompare(b[1]));
    }, [inState]);
    const findings = useMemo(
        () =>
            project === null
                ? inState
                : inState.filter((f) => f.affected.some((a) => a.projects.some((p) => p.id === project))),
        [inState, project]
    );
    const selected = inState.find((f) => f.id === selectedId) ?? null;

    useSubView(selected ? 'finding' : null);
    useEffect(() => {
        onDetailChange(selected !== null);
        return () => onDetailChange(false);
    }, [selected, onDetailChange]);

    const act = useCallback(async (run: () => Promise<{ finding: ExposureFinding }>, fallback: string) => {
        setBusy(true);
        setError(null);
        try {
            await run();
            invalidate('cve.exposure', 'cve.exposureCount', 'cve.inventory');
        } catch (e) {
            setError(cveError(e, fallback));
        } finally {
            setBusy(false);
        }
    }, []);

    const ignore = useCallback(
        (f: ExposureFinding, reason: string) =>
            void act(() => api.send('cve.findingIgnore', { id: f.id, reason }), 'Le constat n’a pas pu être ignoré.'),
        [act]
    );
    const restore = useCallback(
        (f: ExposureFinding) =>
            void act(() => api.send('cve.findingRestore', { id: f.id }), 'Le constat n’a pas pu être rétabli.'),
        [act]
    );

    return {
        state,
        setState,
        project,
        setProject,
        projects,
        findings,
        selected,
        toggle: (id: number) => setSelectedId((cur) => (cur === id ? null : id)),
        close: () => setSelectedId(null),
        busy,
        ignore,
        restore,
        error: error ?? exposure.error,
        loading: exposure.loading,
        scannedAt: exposure.data?.scannedAt ?? null,
        notices: exposure.data?.notices ?? []
    };
}

export type Findings = ReturnType<typeof useFindings>;
