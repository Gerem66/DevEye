import { verifyWsTicket, type AccessClaims } from './jwt';

/** Tickets déjà servis, jusqu'à leur échéance : `jti` → échéance en secondes unix. */
const spent = new Map<string, number>();

function sweep(nowSeconds: number): void {
    for (const [jti, exp] of spent) if (exp <= nowSeconds) spent.delete(jti);
}

/** Vérifie un ticket et le consomme : le second porteur du même ticket est refusé. */
export async function redeemWsTicket(token: string): Promise<AccessClaims | null> {
    const claims = await verifyWsTicket(token);
    if (!claims) return null;
    const now = Math.floor(Date.now() / 1000);
    sweep(now);
    if (spent.has(claims.jti)) return null;
    spent.set(claims.jti, claims.exp);
    return { sub: claims.sub, sid: claims.sid };
}
