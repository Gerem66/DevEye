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

/**
 * Un assemblage dans son worker, avec l'avancement page par page. Hors de tout
 * composant : l'assemblage va au bout même si l'atelier est quitté entre-temps.
 * Le worker ne sert qu'à lui et meurt avec lui, réussi, échoué ou abandonné.
 */
export function runBuild(
    input: BuildInput,
    onProgress: (done: number, total: number) => void,
    signal?: AbortSignal
): Promise<Uint8Array<ArrayBuffer>> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new BuildError('cancelled', 'Assemblage annulé.'));
            return;
        }
        const worker = new BuildWorker();
        const end = (): void => {
            worker.terminate();
            signal?.removeEventListener('abort', abandon);
        };
        const abandon = (): void => {
            end();
            reject(new BuildError('cancelled', 'Assemblage annulé.'));
        };
        worker.addEventListener('message', (event: MessageEvent<BuildReply>) => {
            const reply = event.data;
            if (reply.type === 'progress') {
                onProgress(reply.done, reply.total);
                return;
            }
            end();
            if (reply.type === 'done') resolve(reply.bytes);
            else reject(new BuildError(reply.code, reply.message));
        });
        worker.addEventListener('error', () => {
            end();
            reject(new BuildError('internal', 'L’assemblage du document a échoué.'));
        });
        signal?.addEventListener('abort', abandon);
        onProgress(0, input.pages.length);
        const request: BuildRequest = { type: 'build', id: 1, input };
        worker.postMessage(request);
    });
}
