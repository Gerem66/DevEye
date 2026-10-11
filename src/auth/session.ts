import type { SessionTokens } from '@deveye/types';
import type { FastifyReply } from 'fastify';

import type { Database } from '@/db';
import type { RefreshTokensRepo } from '@/db/repos/refreshTokens';
import { env } from '@/Utils/Env';
import { setAuthCookies } from './cookies';
import type { AuthTransport } from './federation';
import { signAccessToken, signRefreshToken } from './jwt';

export interface IssuedSession {
    sessionId: string;
    /** Les jetons à rendre dans le corps : une session au porteur seulement. */
    tokens?: SessionTokens;
}

/**
 * Émet les jetons d'une session. Le `sessionId` naît à la connexion et survit
 * aux rafraîchissements : c'est ce qui fait d'une session une famille de jetons
 * (une réutilisation détectée la révoque tout entière, descendant compris) et
 * ce qui garde stable la clé du cache de DEK et de la socket.
 *
 * Les jetons partent par le canal du transport, jamais par les deux : en
 * cookies pour notre page, dans le corps pour une origine fédérée.
 */
export async function issueSession(
    reply: FastifyReply,
    db: Database,
    userId: number,
    transport: AuthTransport,
    sessionId: string = db.refreshTokens.newSessionId()
): Promise<IssuedSession> {
    const access = await signAccessToken(userId, sessionId);
    const refresh = await signRefreshToken(userId, sessionId);
    const expiresAt = Math.floor(Date.now() / 1000) + env.JWT_REFRESH_TTL_SECONDS;
    await db.refreshTokens.store({
        jti: refresh.jti,
        userId,
        sessionId,
        token: refresh.token,
        expiresAt
    });
    if (transport === 'bearer') {
        return {
            sessionId,
            tokens: { access, refresh: refresh.token, accessTtlSeconds: env.JWT_ACCESS_TTL_SECONDS }
        };
    }
    setAuthCookies(reply, access, refresh.token);
    return { sessionId };
}

/** Le temps où un jeton tout juste remplacé reste accepté : onglets et rechargements le partagent. */
export const ROTATION_GRACE_SECONDS = 30;

/**
 * Ce que vaut un jeton de rafraîchissement présenté : l'actif, qui tourne ; un
 * prédécesseur tout juste remplacé dans une session qui garde un jeton vivant,
 * toléré ; sinon une réutilisation. Une session révoquée entière (déconnexion,
 * changement de mot de passe, réutilisation détectée) ne garde aucun jeton
 * vivant : les siens ne reviennent pas, même dans la fenêtre.
 */
export async function refreshVerdict(
    tokens: Pick<RefreshTokensRepo, 'isValid' | 'wasRecentlyRotated' | 'hasLiveSession'>,
    claims: { jti: string; sid: string },
    token: string
): Promise<'rotate' | 'grace' | 'reuse'> {
    if (await tokens.isValid(claims.jti, token)) return 'rotate';
    const benign =
        (await tokens.wasRecentlyRotated(claims.jti, token, ROTATION_GRACE_SECONDS)) &&
        (await tokens.hasLiveSession(claims.sid));
    return benign ? 'grace' : 'reuse';
}
