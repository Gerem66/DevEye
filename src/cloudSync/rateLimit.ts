/**
 * Seau à jetons, pour brider un flux d'octets sans à-coups.
 *
 * Écrit ici plutôt que réutilisé : les `rateLimit` du dépôt sont des quotas de
 * requêtes Fastify, qui comptent des appels et refusent au-delà. Ici on ne
 * refuse jamais, on ralentit — ce qui demande une horloge et un crédit, pas un
 * compteur.
 *
 * Le seau se remplit à `bytesPerSecond` et déborde à une seconde de crédit :
 * une pause laisse donc passer une rafale d'au plus une seconde de débit, puis
 * le régime devient exactement celui demandé. Sans ce plafond, un partage
 * inactif depuis une heure accumulerait une heure de crédit et saturerait le
 * lien dès la reprise, ce que l'utilisateur a précisément voulu éviter.
 */
export class TokenBucket {
    private tokens: number;
    private last = Date.now();

    constructor(private readonly bytesPerSecond: number) {
        this.tokens = bytesPerSecond;
    }

    /**
     * Attend d'avoir le droit d'émettre `bytes`. Un bloc plus gros que le seau
     * est autorisé une fois le crédit à zéro : refuser vaudrait blocage
     * définitif dès qu'un chunk dépasse la limite par seconde.
     */
    async take(bytes: number): Promise<void> {
        for (;;) {
            const now = Date.now();
            this.tokens = Math.min(this.bytesPerSecond, this.tokens + ((now - this.last) / 1000) * this.bytesPerSecond);
            this.last = now;
            if (this.tokens >= bytes || this.tokens >= this.bytesPerSecond) {
                this.tokens -= bytes;
                return;
            }
            const missing = Math.min(bytes, this.bytesPerSecond) - this.tokens;
            const waitMs = Math.max(5, Math.ceil((missing / this.bytesPerSecond) * 1000));
            await new Promise((resolve) => setTimeout(resolve, waitMs));
        }
    }
}

/** Un seau, ou `null` quand aucune limite n'est réglée (le défaut). */
export function makeBucket(bytesPerSecond: number | null): TokenBucket | null {
    return bytesPerSecond !== null && bytesPerSecond > 0 ? new TokenBucket(bytesPerSecond) : null;
}
