import { errorNote, WsError, type ErrorNoteInput } from 'deveye-sdk-client';

/** Les codes que `humanizeError` traduit déjà en une phrase qui se suffit. */
const SPOKEN_FOR = new Set(['forbidden', 'validation', 'conflict', 'not_found', 'locked', 'timeout']);

/**
 * La phrase à montrer, et le code qui décide du signalement. Sur les codes que
 * l'app sait dire, sa formulation ; sinon le message du serveur, qui pour ce
 * module est écrit pour être lu (« NVD a répondu HTTP 503. »), et qu'un
 * signalement emporte.
 */
export function cveError(e: unknown, fallback: string): ErrorNoteInput {
    if (e instanceof WsError) {
        if (SPOKEN_FOR.has(e.code)) return errorNote(e, fallback);
        const message = e.message.trim();
        return { message: message.length > 0 ? message : fallback, code: e.code };
    }
    const message = e instanceof Error ? e.message.trim() : '';
    return { message: message.length > 0 ? message : fallback, code: null };
}
