import { ok, REQUEST_PROGRESS_EVENT, type ServerMessage } from '@deveye/types';
import type { CommandProgress } from '@deveye/types/sdk/server';

/** Au plus une trame par quart de seconde : une boucle serrée ne noie pas la socket. */
const MIN_GAP_MS = 250;

export interface ProgressLane {
    report(update: CommandProgress): void;
    /** La réponse part : une trame retenue derrière elle n'aurait plus de requête à qui parler. */
    close(): void;
}

/** L'avancement d'une commande vers sa socket, la dernière trame retenue toujours envoyée. */
export function progressLane(
    requestId: string,
    emit: (msg: ServerMessage) => void,
    now: () => number = Date.now
): ProgressLane {
    let last = -Infinity;
    let pending: CommandProgress | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const flush = (): void => {
        timer = null;
        if (pending === null || closed) return;
        const { done, total, step } = pending;
        pending = null;
        last = now();
        emit({
            command: REQUEST_PROGRESS_EVENT,
            payload: ok({
                requestId,
                done: done === undefined ? undefined : Math.max(0, Math.floor(done)),
                total: total === undefined ? undefined : Math.max(0, Math.floor(total)),
                step: step?.slice(0, 200)
            })
        });
    };

    return {
        report(update) {
            if (closed) return;
            pending = update;
            if (timer !== null) return;
            const wait = last + MIN_GAP_MS - now();
            if (wait <= 0) flush();
            else timer = setTimeout(flush, wait);
        },
        close() {
            closed = true;
            pending = null;
            if (timer !== null) clearTimeout(timer);
            timer = null;
        }
    };
}
