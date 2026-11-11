import { ok, REQUEST_PROGRESS_EVENT, type ServerMessage } from '@deveye/types';
import type { CommandProgress } from '@deveye/types/sdk/server';

/** Au plus une trame par quart de seconde : une boucle serrée ne noie pas la socket. */
const MIN_GAP_MS = 250;

export interface ProgressGate {
    report(update: CommandProgress): void;
    /** La réponse part : un avancement retenu derrière elle n'aurait plus de requête à qui parler. */
    close(): void;
}

export type ProgressLane = ProgressGate;

/** Le régulateur d'un avancement, le dernier retenu toujours rendu, les valeurs bornées. */
export function progressGate(emit: (update: CommandProgress) => void, now: () => number = Date.now): ProgressGate {
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
            done: done === undefined ? undefined : Math.max(0, Math.floor(done)),
            total: total === undefined ? undefined : Math.max(0, Math.floor(total)),
            step: step?.slice(0, 200)
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

/** L'avancement d'une commande vers sa socket. */
export function progressLane(
    requestId: string,
    emit: (msg: ServerMessage) => void,
    now: () => number = Date.now
): ProgressLane {
    return progressGate(
        ({ done, total, step }) =>
            emit({ command: REQUEST_PROGRESS_EVENT, payload: ok({ requestId, done, total, step }) }),
        now
    );
}
