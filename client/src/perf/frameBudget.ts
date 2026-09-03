import { recordVerdict, shouldProbe } from '@/stores/render';

/**
 * Mesure du budget de frame réel, pour décider seul du mode de rendu.
 *
 * Aucun user-agent ne dit « accélération matérielle désactivée », et un appareil
 * lent tient les 60 fps sur une page au repos : la sonde ne s'ouvre donc que
 * pendant les moments animés, armée par les scènes qui coûtent (montage de
 * l'accueil, ouverture d'une popup ou d'un dossier).
 */

/**
 * Une frame compte comme décrochée au-delà de ce seuil. Volontairement haut : à
 * 45 ms, un écran 30 Hz (33 ms) ne peut pas être pris pour un appareil lent.
 */
const STALL_MS = 45;

/** En deçà, l'échantillon ne suffit pas à conclure. */
const MIN_FRAMES = 180;

/** Part de frames décrochées à partir de laquelle le rendu passe en léger. */
const STALL_RATIO = 0.25;

/**
 * Un écart plus grand n'est pas une frame lente mais une interruption (onglet
 * masqué, veille, tâche du système) : il fausserait la mesure.
 */
const OUTLIER_MS = 500;

let frames = 0;
let stalls = 0;
let windowEndsAt = 0;
let rafId: number | null = null;
let last = 0;

function step(now: number): void {
    rafId = null;
    if (!shouldProbe()) return;

    const dt = now - last;
    last = now;
    if (dt > 0 && dt < OUTLIER_MS && document.visibilityState === 'visible') {
        frames++;
        if (dt > STALL_MS) stalls++;
    }

    if (frames >= MIN_FRAMES) {
        recordVerdict(stalls / frames >= STALL_RATIO ? 'lite' : 'full');
        return;
    }

    if (now < windowEndsAt) rafId = requestAnimationFrame(step);
}

/**
 * Ouvre (ou prolonge) une fenêtre de mesure. Les fenêtres s'additionnent : le
 * verdict tombe dès que le cumul suffit, quitte à traverser plusieurs scènes.
 */
export function armFrameProbe(durationMs: number): void {
    if (!shouldProbe() || typeof requestAnimationFrame !== 'function') return;
    const now = performance.now();
    windowEndsAt = Math.max(windowEndsAt, now + durationMs);
    if (rafId !== null) return;
    // La première frame après une pause mesure l'attente, pas le rendu.
    last = now;
    rafId = requestAnimationFrame(step);
}
