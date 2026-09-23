/**
 * L'ouverture du formulaire de signalement depuis n'importe où : une feature
 * coincée par un refus qu'elle ne sait pas réparer doit pouvoir offrir ce
 * recours sans connaître le bouton flottant qui le porte.
 *
 * Même mécanique que `viewRequest` : le bouton enregistre l'unique gestionnaire,
 * et une demande faite quand aucun n'est enregistré tombe.
 */
type OpenReportHandler = (context: string | null) => void;

let handler: OpenReportHandler | null = null;

/** Enregistre le gestionnaire (le bouton de signalement). Rend son retrait. */
export function onOpenReportRequest(fn: OpenReportHandler): () => void {
    handler = fn;
    return () => {
        if (handler === fn) handler = null;
    };
}

/**
 * Ouvre le formulaire de signalement. `context` décrit ce qui a échoué et
 * amorce le message : sans lui, le formulaire s'ouvre vierge.
 */
export function requestOpenReport(context: string | null = null): void {
    handler?.(context);
}
