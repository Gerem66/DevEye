import {
    FEEDBACK_ERRORS_KEPT,
    FEEDBACK_REQUESTS_KEPT,
    FEEDBACK_VIEWS_KEPT,
    type FeedbackErrorTrace,
    type FeedbackRequestTrace,
    type FeedbackViewTrace
} from '@deveye/types';

/**
 * Ce que le client garde de son propre passé, pour le joindre à un signalement
 * de bug : les dernières requêtes, les erreurs que personne n'a rattrapées, et
 * les vues traversées.
 *
 * Trois anneaux bornés, en mémoire seulement : rien n'est persisté, rien ne
 * part sans que l'utilisateur envoie un signalement.
 *
 * Ce qui n'y entre JAMAIS : le corps d'une requête et celui d'une réponse. Un
 * mot de passe, un contenu déchiffré ou une clé d'API y transiteraient, et un
 * rapport se lit dans une page d'administration. Une requête n'est décrite que
 * par l'adresse visée, le temps mis et son issue.
 */

/** Une entrée d'anneau, avant que l'instant relatif ne soit calculé. */
interface Stamped<T> {
    at: number;
    value: T;
}

/** Ajoute en tête et rogne la queue : le plus récent d'abord, toujours. */
function push<T>(ring: Stamped<T>[], value: T, kept: number): void {
    ring.unshift({ at: Date.now(), value });
    if (ring.length > kept) ring.length = kept;
}

/** Fige l'anneau en datant chaque entrée par rapport à `now`. */
function freeze<T extends { ago: number }>(ring: Stamped<Omit<T, 'ago'>>[], now: number): T[] {
    return ring.map((e) => ({ ...e.value, ago: Math.max(0, now - e.at) }) as T);
}

const requests: Stamped<Omit<FeedbackRequestTrace, 'ago'>>[] = [];
const errors: Stamped<Omit<FeedbackErrorTrace, 'ago'>>[] = [];
const views: Stamped<Omit<FeedbackViewTrace, 'ago'>>[] = [];

/** Instant du chargement de l'onglet : donne l'âge de la session au rapport. */
const loadedAt = Date.now();

/** Une chaîne bornée, ou `null` si elle est vide. */
function clamp(value: string | null | undefined, max: number): string | null {
    if (!value) return null;
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * Consigne une requête achevée. Appelée par les deux seuls points de passage du
 * client : `ws.send` pour les commandes, `request` pour l'authentification.
 */
export function noteRequest(entry: Omit<FeedbackRequestTrace, 'ago'>): void {
    push(
        requests,
        { ...entry, target: entry.target.slice(0, 200), outcome: entry.outcome.slice(0, 40) },
        FEEDBACK_REQUESTS_KEPT
    );
}

/** Consigne la vue qui vient de s'ouvrir, ou `home` quand elle se referme. */
export function noteView(view: string): void {
    if (views[0]?.value.view === view) return;
    push(views, { view: view.slice(0, 64) }, FEEDBACK_VIEWS_KEPT);
}

/**
 * L'issue d'un appel manqué. Lue par canard sur `code` plutôt que par
 * `instanceof` : `WsError` et `ApiError` la portent tous deux, et les importer
 * ici ferait un cycle avec les deux modules qui appellent {@link traceCall}.
 */
function outcomeOf(err: unknown): string {
    if (err !== null && typeof err === 'object' && 'code' in err) {
        const code: unknown = (err as { code: unknown }).code;
        if (typeof code === 'string') return code;
    }
    return 'error';
}

/**
 * Consigne l'issue d'un appel une fois qu'il retombe, sans rien changer à ce
 * qu'il rend : les deux points de passage du client s'enveloppent avec ça.
 */
export function traceCall<T>(
    channel: FeedbackRequestTrace['channel'],
    target: string,
    startedAt: number,
    call: Promise<T>
): Promise<T> {
    return call.then(
        (value) => {
            noteRequest({ channel, target, durationMs: Date.now() - startedAt, outcome: 'ok' });
            return value;
        },
        (err: unknown) => {
            noteRequest({ channel, target, durationMs: Date.now() - startedAt, outcome: outcomeOf(err) });
            throw err;
        }
    );
}

function noteError(entry: Omit<FeedbackErrorTrace, 'ago'>): void {
    push(errors, entry, FEEDBACK_ERRORS_KEPT);
}

/**
 * Branche la capture des erreurs que rien n'attrape : un plantage de rendu et
 * une promesse rejetée ne laissaient aucune trace, l'écran devenait blanc en
 * silence. Appelée une fois, au démarrage du client.
 */
export function installErrorTrace(): void {
    window.addEventListener('error', (e) => {
        const origin = e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : null;
        noteError({
            source: 'error',
            message: clamp(e.message, 500) ?? 'Erreur sans message',
            origin: clamp(origin, 300),
            stack: clamp(e.error instanceof Error ? e.error.stack : null, 2000)
        });
    });

    window.addEventListener('unhandledrejection', (e) => {
        const reason: unknown = e.reason;
        const isError = reason instanceof Error;
        noteError({
            source: 'rejection',
            message: clamp(isError ? reason.message : String(reason), 500) ?? 'Promesse rejetée sans motif',
            origin: null,
            stack: clamp(isError ? reason.stack : null, 2000)
        });
    });
}

/** Les trois anneaux, datés par rapport à maintenant, plus l'âge de la session. */
export function readTrace(): {
    requests: FeedbackRequestTrace[];
    errors: FeedbackErrorTrace[];
    views: FeedbackViewTrace[];
    sessionAgeSeconds: number;
    currentView: string | null;
} {
    const now = Date.now();
    const current = views[0]?.value.view ?? null;
    return {
        requests: freeze<FeedbackRequestTrace>(requests, now),
        errors: freeze<FeedbackErrorTrace>(errors, now),
        views: freeze<FeedbackViewTrace>(views, now),
        sessionAgeSeconds: Math.floor((now - loadedAt) / 1000),
        currentView: current === 'home' ? null : current
    };
}
