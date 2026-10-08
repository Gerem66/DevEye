import type { ReactNode } from 'react';

/**
 * Une limite d'offre touchée, d'où qu'elle vienne : le client WS signale ici
 * une commande refusée pour `quota_exceeded`, un module y ouvre l'offre Pro
 * avant même d'envoyer, et l'invite montée par l'accueil montre l'un ou
 * l'autre. Aucun module n'a à traiter ce refus lui-même.
 */
export type QuotaPromptRequest =
    /**
     * `paused` : l'élément visé est en pause, et non une création refusée.
     * `priority` : le refus vient de la priorité aux abonnés, pas de l'offre.
     */
    | { kind: 'refusal'; message: string; paused: boolean; priority: boolean }
    /** Ce que l'offre du propriétaire n'inclut pas du tout : la limite vaut zéro. */
    | { kind: 'pro'; title: string; body: ReactNode };

type Listener = (request: QuotaPromptRequest) => void;

let listener: Listener | null = null;

export const PRO_OFFER_TITLE = 'Disponible avec l’offre Pro';

export function onQuotaExceeded(fn: Listener): () => void {
    listener = fn;
    return () => {
        if (listener === fn) listener = null;
    };
}

/**
 * Une limite à zéro n'est pas « atteinte » : la fonctionnalité n'est pas dans
 * l'offre. L'invite le dit ainsi, plutôt que « Limite atteinte : 0 ».
 */
export function notifyQuotaExceeded(message: string, paused = false, priority = false, notIncluded = false): void {
    listener?.(
        notIncluded && !paused && !priority
            ? {
                  kind: 'pro',
                  title: PRO_OFFER_TITLE,
                  body: 'L’offre actuelle n’inclut pas cette fonctionnalité : elle fait partie de l’offre Pro.'
              }
            : { kind: 'refusal', message, paused, priority }
    );
}

/** Ouvre l'invite de l'offre Pro, avant tout envoi : ce qu'un écran sait déjà réservé aux abonnés. */
export function openProOffer(input: { title?: string; body: ReactNode }): void {
    listener?.({ kind: 'pro', title: input.title ?? PRO_OFFER_TITLE, body: input.body });
}
