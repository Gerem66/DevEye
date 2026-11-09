import { BuildFailure, buildPdf, type BuildInput } from './build';

/**
 * L'assemblage hors du fil de l'écran : un document de quelques centaines de
 * pages se copie en secondes, pendant lesquelles l'atelier reste fluide.
 */

export type BuildRequest = { type: 'build'; id: number; input: BuildInput };

export type BuildReply =
    | { type: 'progress'; id: number; done: number; total: number }
    | { type: 'done'; id: number; bytes: Uint8Array<ArrayBuffer> }
    | { type: 'error'; id: number; code: string; message: string };

/** Le worker vu de l'intérieur ; les types du DOM ne connaissent que la fenêtre. */
const scope = self as unknown as {
    postMessage(message: BuildReply, transfer?: Transferable[]): void;
    addEventListener(type: 'message', listener: (event: MessageEvent<BuildRequest>) => void): void;
};

scope.addEventListener('message', (event) => {
    const { id, input } = event.data;
    void buildPdf(input, (done, total) => scope.postMessage({ type: 'progress', id, done, total }))
        .then((bytes) => {
            const transferable = bytes as Uint8Array<ArrayBuffer>;
            scope.postMessage({ type: 'done', id, bytes: transferable }, [transferable.buffer]);
        })
        .catch((e: unknown) => {
            const failure = e instanceof BuildFailure ? e : null;
            scope.postMessage({
                type: 'error',
                id,
                code: failure?.code ?? 'internal',
                message: failure?.message ?? 'Le document n’a pas pu être assemblé.'
            });
        });
});
