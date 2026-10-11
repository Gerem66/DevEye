/**
 * La confirmation qui ouvre le pilotage des machines : un code d'application
 * saisi dans CETTE session. En mémoire, par session : un cookie volé n'hérite
 * pas de celle d'un autre onglet du compte, et un redémarrage du serveur la
 * redemande. La fenêtre glisse à chaque action sur une machine, sous un plafond
 * que rien ne prolonge.
 */

/** Une session confirmée ne pilote jamais plus longtemps, même active sans relâche. */
export const STEP_UP_HARD_CAP_MS = 12 * 3600 * 1000;

interface Confirmation {
    userId: number;
    confirmedAt: number;
    lastUseAt: number;
}

const confirmations = new Map<string, Confirmation>();

export function rememberStepUp(sessionId: string, userId: number, now = Date.now()): void {
    // Les sessions parties sans revenir ne s'accumulent pas : passé le plafond,
    // plus rien ne les rouvrirait.
    for (const [id, entry] of confirmations) {
        if (now - entry.confirmedAt >= STEP_UP_HARD_CAP_MS) confirmations.delete(id);
    }
    confirmations.set(sessionId, { userId, confirmedAt: now, lastUseAt: now });
}

/** Quand la confirmation de cette session tombe, `null` sans confirmation valable. */
export function stepUpUntil(sessionId: string, userId: number, windowMs: number, now = Date.now()): number | null {
    const entry = confirmations.get(sessionId);
    if (!entry || entry.userId !== userId) return null;
    const until = Math.min(entry.lastUseAt + windowMs, entry.confirmedAt + STEP_UP_HARD_CAP_MS);
    if (now >= until) {
        confirmations.delete(sessionId);
        return null;
    }
    return until;
}

/** Une action sur une machine vient d'avoir lieu : la fenêtre repart. */
export function touchStepUp(sessionId: string, now = Date.now()): void {
    const entry = confirmations.get(sessionId);
    if (entry) entry.lastUseAt = now;
}

export function forgetStepUp(sessionId: string): void {
    confirmations.delete(sessionId);
}

/**
 * Toutes les confirmations d'un compte, sauf la session qui vient de prouver son
 * secret : mot de passe changé, coffre récupéré, compte suspendu, 2FA retirée.
 */
export function forgetStepUpsOf(userId: number, keepSessionId?: string): void {
    for (const [sessionId, entry] of confirmations) {
        if (entry.userId === userId && sessionId !== keepSessionId) confirmations.delete(sessionId);
    }
}
