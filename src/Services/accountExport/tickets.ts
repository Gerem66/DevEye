import { randomBytes } from 'node:crypto';

/** Le lien d'un export vaut cinq minutes, le temps de cliquer. */
export const EXPORT_TICKET_MS = 5 * 60_000;
/** Un export tient une clé et une réponse ouvertes : peu à la fois sur tout le serveur. */
const MAX_RUNNING = 3;

export interface ExportTicket {
    userId: number;
    /** La session qui a donné le mot de passe : le lien ne vaut que pour elle. */
    sessionId: string;
    leaveOut: readonly string[];
    /** Le jeton de la clé prêtée (`lendExportDek`), jamais dans une URL. */
    dekToken: string;
    expiresAt: number;
}

const tickets = new Map<string, ExportTicket>();
const running = new Set<number>();

function sweep(now: number, onDrop: (ticket: ExportTicket) => void): void {
    for (const [token, ticket] of tickets) {
        if (now >= ticket.expiresAt) {
            tickets.delete(token);
            onDrop(ticket);
        }
    }
}

/** Émet le lien d'un export. Un lien précédent du même compte meurt : `onDrop` rend sa clé. */
export function issueExportTicket(
    input: Omit<ExportTicket, 'expiresAt'>,
    onDrop: (ticket: ExportTicket) => void,
    now = Date.now()
): { token: string; expiresAt: number } {
    sweep(now, onDrop);
    for (const [token, ticket] of tickets) {
        if (ticket.userId === input.userId) {
            tickets.delete(token);
            onDrop(ticket);
        }
    }
    const token = randomBytes(32).toString('base64url');
    const expiresAt = now + EXPORT_TICKET_MS;
    tickets.set(token, { ...input, expiresAt });
    return { token, expiresAt };
}

/** Consomme le lien : une seule fois, même quand il ne vaut plus rien. `null` : inconnu ou expiré. */
export function redeemExportTicket(
    token: string,
    onDrop: (ticket: ExportTicket) => void,
    now = Date.now()
): ExportTicket | null {
    const ticket = tickets.get(token);
    if (!ticket) return null;
    tickets.delete(token);
    if (now >= ticket.expiresAt) {
        onDrop(ticket);
        return null;
    }
    return ticket;
}

/** Réserve la place d'un export en cours. `false` : ce compte en a déjà un, ou le serveur est plein. */
export function beginExport(userId: number): boolean {
    if (running.has(userId) || running.size >= MAX_RUNNING) return false;
    running.add(userId);
    return true;
}

export function endExport(userId: number): void {
    running.delete(userId);
}

/** Pour les tests : l'état à zéro. */
export function resetExportTicketsForTest(): void {
    tickets.clear();
    running.clear();
}
