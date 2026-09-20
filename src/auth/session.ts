import type { SessionTokens } from '@deveye/types';
import type { FastifyReply } from 'fastify';

import type { Database } from '@/db';
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
