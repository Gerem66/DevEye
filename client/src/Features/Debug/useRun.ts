import { useCallback, useEffect, useRef, useState } from 'react';
import type { DebugRun, DebugRunKind } from '@deveye/types';

import { ws, WsError } from '@/api/ws';

const POLL_MS = 1000;
const HISTORY = 20;

/**
 * Un essai qui tourne sur le serveur plus longtemps qu'une commande : lancé,
 * puis relu chaque seconde jusqu'à sa fin. Rattaché après un rechargement de
 * la page par l'essai en cours que dit `debug.overview`.
 */
export function useRun(kind: DebugRunKind, activeRunId: number | null) {
    const [run, setRun] = useState<DebugRun | null>(null);
    const [history, setHistory] = useState<DebugRun[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [starting, setStarting] = useState(false);
    const polled = useRef<number | null>(null);

    const loadHistory = useCallback(async () => {
        try {
            const { runs } = await ws.send('debug.runList', { kind, limit: HISTORY });
            setHistory(runs);
            setRun((current) => current ?? runs[0] ?? null);
        } catch (e) {
            setError(e instanceof WsError ? e.message : 'Historique illisible.');
        }
    }, [kind]);

    const follow = useCallback(
        (runId: number) => {
            if (polled.current === runId) return;
            polled.current = runId;
            const tick = async (): Promise<void> => {
                if (polled.current !== runId) return;
                try {
                    const next = await ws.send('debug.runGet', { runId });
                    setRun(next);
                    if (next.status === 'running') {
                        setTimeout(() => void tick(), POLL_MS);
                        return;
                    }
                } catch (e) {
                    setError(e instanceof WsError ? e.message : 'Essai illisible.');
                }
                polled.current = null;
                void loadHistory();
            };
            void tick();
        },
        [loadHistory]
    );

    useEffect(() => {
        void loadHistory();
        return () => {
            polled.current = null;
        };
    }, [loadHistory]);

    useEffect(() => {
        if (activeRunId !== null) follow(activeRunId);
    }, [activeRunId, follow]);

    const start = useCallback(
        async (launch: () => Promise<{ runId: number }>) => {
            setError(null);
            setStarting(true);
            try {
                const { runId } = await launch();
                follow(runId);
            } catch (e) {
                setError(e instanceof WsError ? e.message : 'Lancement impossible.');
            } finally {
                setStarting(false);
            }
        },
        [follow]
    );

    const abort = useCallback(async () => {
        if (!run || run.status !== 'running') return;
        try {
            await ws.send('debug.runAbort', { runId: run.id });
        } catch (e) {
            setError(e instanceof WsError ? e.message : 'Arrêt impossible.');
        }
    }, [run]);

    return {
        run,
        history,
        error,
        running: run?.status === 'running' || starting,
        start,
        abort,
        show: setRun
    };
}
