/**
 * Le `href` d'un lien dont l'adresse vient d'une donnée (flux tiers, saisie d'un
 * autre membre, sonde) : seuls http(s) et mailto en sortent. Un `javascript:`
 * arrivé par un flux distant serait sinon à un clic de s'exécuter dans l'app.
 */
export function safeHref(url: string | null | undefined): string | undefined {
    if (!url) return undefined;
    try {
        const parsed = new URL(url, window.location.origin);
        return ['http:', 'https:', 'mailto:'].includes(parsed.protocol) ? parsed.toString() : undefined;
    } catch {
        return undefined;
    }
}
