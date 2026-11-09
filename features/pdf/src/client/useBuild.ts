import { useCallback, useEffect, useRef, useState } from 'react';

import type { BuildInput } from './build';
import BuildWorker from './build.worker?worker';
import type { BuildReply, BuildRequest } from './build.worker';

export class BuildError extends Error {
    constructor(
        readonly code: string,
        message: string
    ) {
        super(message);
    }
}

export interface BuildProgress {
    done: number;
    total: number;
}

/** L'assemblage dans son worker, un à la fois, avec l'avancement page par page. */
export function useBuild(): {
    build: (input: BuildInput) => Promise<Uint8Array<ArrayBuffer>>;
    progress: BuildProgress | null;
} {
    const worker = useRef<Worker | null>(null);
    const seq = useRef(0);
    const [progress, setProgress] = useState<BuildProgress | null>(null);

    useEffect(
        () => () => {
            worker.current?.terminate();
            worker.current = null;
        },
        []
    );

    const build = useCallback((input: BuildInput): Promise<Uint8Array<ArrayBuffer>> => {
        worker.current ??= new BuildWorker();
        const current = worker.current;
        const id = ++seq.current;
        setProgress({ done: 0, total: input.pages.length });
        return new Promise((resolve, reject) => {
            const detach = () => {
                current.removeEventListener('message', onMessage);
                current.removeEventListener('error', onError);
                setProgress(null);
            };
            const onMessage = (event: MessageEvent<BuildReply>) => {
                const reply = event.data;
                if (reply.id !== id) return;
                if (reply.type === 'progress') {
                    setProgress({ done: reply.done, total: reply.total });
                    return;
                }
                detach();
                if (reply.type === 'done') resolve(reply.bytes);
                else reject(new BuildError(reply.code, reply.message));
            };
            // Le worker lui-même a cassé : on en reprendra un neuf à l'assemblage suivant.
            const onError = () => {
                detach();
                current.terminate();
                if (worker.current === current) worker.current = null;
                reject(new BuildError('internal', 'L’assemblage du document a échoué.'));
            };
            current.addEventListener('message', onMessage);
            current.addEventListener('error', onError);
            const request: BuildRequest = { type: 'build', id, input };
            current.postMessage(request);
        });
    }, []);

    return { build, progress };
}
