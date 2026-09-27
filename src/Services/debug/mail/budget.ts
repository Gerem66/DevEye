/**
 * Un plafond glissant par clé : `limit` passages par `windowMs`. Le testeur de
 * mails écrit depuis l'expéditeur du serveur : une session d'administrateur
 * volée ne doit pas en faire un canon à spam qui ruinerait sa réputation.
 */
export function createBudget(limit: number, windowMs: number, now: () => number = Date.now) {
    const spent = new Map<string, number[]>();
    return {
        take(key: string): boolean {
            const t = now();
            const recent = (spent.get(key) ?? []).filter((at) => t - at < windowMs);
            if (recent.length >= limit) {
                spent.set(key, recent);
                return false;
            }
            recent.push(t);
            spent.set(key, recent);
            return true;
        }
    };
}
