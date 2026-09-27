import { noteView } from '@/diagnostics/trace';
import { onView } from './views';

const FLUSH_MS = 5000;
const BATCH_MAX = 20;
/** Posé chez qui le serveur écarte du suivi (un administrateur) : ses pages d'avant la connexion ne comptent pas non plus. */
const SKIP_KEY = 'deveye:tracking-skip';

interface View {
    path: string;
    at: number;
    referrer?: string;
    language?: string;
    timezone?: string;
    tzOffset?: number;
    screenWidth?: number;
}

let active = false;
let zone: 'auth' | 'app' | null = null;
let firstView = true;
const queue: View[] = [];

function skipped(): boolean {
    try {
        return localStorage.getItem(SKIP_KEY) === '1';
    } catch {
        return false;
    }
}

function rememberSkip(skip: boolean): void {
    try {
        if (skip) localStorage.setItem(SKIP_KEY, '1');
        else localStorage.removeItem(SKIP_KEY);
    } catch {
        // Le choix ne sera pas retenu : sans conséquence.
    }
}

/** Le serveur dit s'il suit ce navigateur ; relu à chaque passage entre les pages d'avant et d'après la connexion. */
async function refresh(next: 'auth' | 'app'): Promise<void> {
    zone = next;
    try {
        const response = await fetch('/api/tracking', { credentials: 'same-origin' });
        const body = (await response.json()) as { ok: boolean; data?: { active: boolean; excluded: boolean } };
        const state = body.data ?? { active: false, excluded: false };
        if (next === 'app' && state.active) rememberSkip(state.excluded);
        active = state.active && !state.excluded && !(next === 'auth' && skipped());
    } catch {
        active = false;
    }
}

function contextOf(): Omit<View, 'path' | 'at'> {
    const referrer =
        firstView && document.referrer && new URL(document.referrer).host !== location.host
            ? document.referrer
            : undefined;
    firstView = false;
    return {
        ...(referrer ? { referrer } : {}),
        language: navigator.language,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        tzOffset: new Date().getTimezoneOffset(),
        screenWidth: window.screen.width
    };
}

function flush(): void {
    if (queue.length === 0) return;
    const body = JSON.stringify({ views: queue.splice(0, BATCH_MAX) });
    // `text/plain` : une requête simple, sans préalable OPTIONS, que la fermeture de la page n'interrompt pas.
    const blob = new Blob([body], { type: 'text/plain' });
    if (!navigator.sendBeacon?.('/api/tracking', blob)) {
        void fetch('/api/tracking', { method: 'POST', body: blob, keepalive: true, credentials: 'same-origin' });
    }
}

/** Branche le rapport de bug et le suivi d'usage sur la page affichée. */
export function startTracking(): void {
    onView((path) => {
        noteView(path);
        const next = path.startsWith('/auth') ? 'auth' : 'app';
        const ready = next === zone ? Promise.resolve() : refresh(next);
        void ready.then(() => {
            if (active) queue.push({ path, at: Date.now(), ...contextOf() });
        });
    });
    setInterval(flush, FLUSH_MS);
    addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flush();
    });
}
