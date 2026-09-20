import type { FastifyReply } from 'fastify';

import type { Database } from '@/db';
import { env } from '@/Utils/Env';
import { setAuthCookies } from './cookies';
import { signAccessToken, signRefreshToken } from './jwt';

/**
 * Émet les jetons d'une session. Le `sessionId` naît à la connexion et survit
 * aux rafraîchissements : c'est ce qui fait d'une session une famille de jetons
 * (une réutilisation détectée la révoque tout entière, descendant compris) et
 * ce qui garde stable la clé du cache de DEK et de la socket.
 */
export async function issueSession(
    reply: FastifyReply,
    db: Database,
    userId: number,
    sessionId: string = db.refreshTokens.newSessionId()
): Promise<string> {
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
    setAuthCookies(reply, access, refresh.token);
    return sessionId;
}
