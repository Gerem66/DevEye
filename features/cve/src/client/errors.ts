import { humanizeError, WsError } from 'deveye-sdk-client';

/**
 * Ce qu'une requête ratée doit dire à l'écran : une phrase, et le code quand la
 * phrase seule ne suffit pas à savoir ce qui s'est passé.
 */
export interface CveError {
    text: string;
    /** Le code du serveur, montré seulement quand il apprend quelque chose. */
    code: string | null;
}

/**
 * Les codes que `humanizeError` traduit déjà en une phrase qui se suffit : les
 * afficher avec leur code ne ferait que du bruit.
 */
const SPOKEN_FOR = new Set(['forbidden', 'validation', 'conflict', 'not_found', 'locked', 'timeout']);

/**
 * La phrase à montrer. Sur les codes que l'app sait dire, sa formulation ; sinon
 * le message du serveur, qui pour ce module est écrit pour être lu (« Quota du
 * NVD atteint… »). Une exception non prévue arrive avec le message générique du
 * dispatcheur, d'où le code affiché à côté : sans lui il n'y aurait rien à
 * rapporter.
 */
export function cveError(e: unknown, fallback: string): CveError {
    if (e instanceof WsError) {
        if (SPOKEN_FOR.has(e.code)) return { text: humanizeError(e, fallback), code: null };
        const message = e.message.trim();
        return { text: message.length > 0 ? message : fallback, code: e.code };
    }
    const message = e instanceof Error ? e.message.trim() : '';
    return { text: message.length > 0 ? message : fallback, code: null };
}
