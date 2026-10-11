import { env } from '@/Utils/Env';
import { randomUUID } from 'crypto';
import { SignJWT, errors as joseErrors, jwtVerify } from 'jose';

/** Tous nos jetons sont signés HS256 ; rien d'autre n'est accepté à la vérification. */
const JWT_ALGORITHMS = ['HS256'];

const issuer = 'deveye';
const audience = 'deveye-client';

const accessSecret = new TextEncoder().encode(env.JWT_ACCESS_SECRET);
const refreshSecret = new TextEncoder().encode(env.JWT_REFRESH_SECRET);
const deviceSecret = new TextEncoder().encode(env.DEVICE_TOKEN_SECRET);

export interface AccessClaims {
    sub: string; // user id
    sid: string; // session id (matches refresh family)
}

export interface RefreshClaims {
    sub: string;
    sid: string;
    jti: string; // unique per refresh token
}

export async function signAccessToken(userId: number, sessionId: string): Promise<string> {
    return new SignJWT({ sid: sessionId })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(String(userId))
        .setIssuer(issuer)
        .setAudience(audience)
        .setIssuedAt()
        .setExpirationTime(`${env.JWT_ACCESS_TTL_SECONDS}s`)
        .sign(accessSecret);
}

export async function signRefreshToken(
    userId: number,
    sessionId: string,
    jti: string = randomUUID()
): Promise<{ token: string; jti: string }> {
    const token = await new SignJWT({ sid: sessionId, jti })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(String(userId))
        .setIssuer(issuer)
        .setAudience(audience)
        .setJti(jti)
        .setIssuedAt()
        .setExpirationTime(`${env.JWT_REFRESH_TTL_SECONDS}s`)
        .sign(refreshSecret);
    return { token, jti };
}

export async function verifyAccessToken(token: string): Promise<AccessClaims | null> {
    try {
        const { payload } = await jwtVerify(token, accessSecret, { issuer, audience, algorithms: JWT_ALGORITHMS });
        if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') return null;
        return { sub: payload.sub, sid: payload.sid };
    } catch (e) {
        if (e instanceof joseErrors.JWTExpired || e instanceof joseErrors.JWTInvalid) return null;
        return null;
    }
}

export async function verifyRefreshToken(token: string): Promise<RefreshClaims | null> {
    try {
        const { payload } = await jwtVerify(token, refreshSecret, { issuer, audience, algorithms: JWT_ALGORITHMS });
        if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string' || typeof payload.jti !== 'string') {
            return null;
        }
        return { sub: payload.sub, sid: payload.sid, jti: payload.jti };
    } catch {
        return null;
    }
}

export interface DeviceClaims {
    sub: string; // device id
    oid: number; // owner user id
    /** Expiry, unix seconds. Absent on a token minted before tokens expired: the server rotates it at the next connection. */
    exp?: number;
}

/** A device token lives this long; the server replaces it at connection once it nears the end (`agent/ws.ts`). */
export const DEVICE_TOKEN_TTL_SECONDS = 30 * 24 * 3600;

/** Device token. Revocation is enforced via DB status + token hash; expiry bounds what a leaked copy is worth. */
export async function signDeviceToken(deviceId: string, ownerId: number): Promise<string> {
    return new SignJWT({ oid: ownerId, typ: 'device' })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(deviceId)
        .setIssuer(issuer)
        .setAudience('deveye-agent')
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + DEVICE_TOKEN_TTL_SECONDS)
        .sign(deviceSecret);
}

export async function verifyDeviceToken(token: string): Promise<DeviceClaims | null> {
    try {
        const { payload } = await jwtVerify(token, deviceSecret, {
            issuer,
            audience: 'deveye-agent',
            algorithms: JWT_ALGORITHMS
        });
        if (typeof payload.sub !== 'string' || typeof payload.oid !== 'number') return null;
        return { sub: payload.sub, oid: payload.oid, exp: payload.exp };
    } catch {
        return null;
    }
}

/**
 * Short-lived token proving a password check passed, pending the codes of a
 * login (`auth/loginChallenge.ts`). It names the challenge held server-side,
 * no secret material lives in it.
 */
export async function signLoginChallenge(userId: number, challengeId: string): Promise<string> {
    return new SignJWT({ purpose: 'login', cid: challengeId })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(String(userId))
        .setIssuer(issuer)
        .setAudience('deveye-login')
        .setIssuedAt()
        .setExpirationTime(`${env.LOGIN_CHALLENGE_TTL_SECONDS}s`)
        .sign(accessSecret);
}

export async function verifyLoginChallenge(token: string): Promise<{ userId: number; challengeId: string } | null> {
    try {
        const { payload } = await jwtVerify(token, accessSecret, {
            issuer,
            audience: 'deveye-login',
            algorithms: JWT_ALGORITHMS
        });
        if (typeof payload.sub !== 'string' || payload.purpose !== 'login' || typeof payload.cid !== 'string') {
            return null;
        }
        return { userId: Number(payload.sub), challengeId: payload.cid };
    } catch {
        return null;
    }
}

/** Durée d'un ticket de socket : le temps d'ouvrir la connexion, pas plus. */
const WS_TICKET_TTL_SECONDS = 30;

export interface WsTicketClaims extends AccessClaims {
    jti: string;
    /** Échéance, en secondes unix : borne la mémoire des tickets déjà servis. */
    exp: number;
}

/**
 * Ce qu'une page fédérée présente pour ouvrir sa socket (`/ws?ticket=`), un
 * navigateur ne sachant poser aucun en-tête sur une WebSocket. Il finit dans
 * une URL, donc dans des journaux : il ne vaut que quelques secondes et une
 * seule fois (`auth/wsTicket.ts`).
 */
export async function signWsTicket(userId: number, sessionId: string): Promise<string> {
    return new SignJWT({ sid: sessionId })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(String(userId))
        .setIssuer(issuer)
        .setAudience('deveye-ws')
        .setJti(randomUUID())
        .setIssuedAt()
        .setExpirationTime(`${WS_TICKET_TTL_SECONDS}s`)
        .sign(accessSecret);
}

export async function verifyWsTicket(token: string): Promise<WsTicketClaims | null> {
    try {
        const { payload } = await jwtVerify(token, accessSecret, {
            issuer,
            audience: 'deveye-ws',
            algorithms: JWT_ALGORITHMS
        });
        if (
            typeof payload.sub !== 'string' ||
            typeof payload.sid !== 'string' ||
            typeof payload.jti !== 'string' ||
            typeof payload.exp !== 'number'
        ) {
            return null;
        }
        return { sub: payload.sub, sid: payload.sid, jti: payload.jti, exp: payload.exp };
    } catch {
        return null;
    }
}

/**
 * Le ticket de session d'un module : ce qu'un module tend au navigateur pour une
 * route publique de son service (URL de téléchargement, `state` OAuth). L'audience
 * porte l'identifiant du module, donc un ticket n'est rendu qu'à son émetteur ;
 * la charge utile est celle du module, l'identité celle de l'hôte.
 */
export interface ModuleTicketClaims {
    userId: number;
    workspaceId: number;
    sessionId: string;
    payload: unknown;
}

export async function signModuleTicket(
    featureId: string,
    claims: ModuleTicketClaims,
    ttlSeconds: number
): Promise<string> {
    return new SignJWT({ ws: claims.workspaceId, sid: claims.sessionId, payload: claims.payload })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(String(claims.userId))
        .setIssuer(issuer)
        .setAudience(`deveye-module:${featureId}`)
        .setIssuedAt()
        .setExpirationTime(`${ttlSeconds}s`)
        .sign(accessSecret);
}

export async function verifyModuleTicket(featureId: string, token: string): Promise<ModuleTicketClaims | null> {
    try {
        const { payload } = await jwtVerify(token, accessSecret, {
            issuer,
            audience: `deveye-module:${featureId}`,
            algorithms: JWT_ALGORITHMS
        });
        if (typeof payload.sub !== 'string' || typeof payload.ws !== 'number' || typeof payload.sid !== 'string') {
            return null;
        }
        return {
            userId: Number(payload.sub),
            workspaceId: payload.ws,
            sessionId: payload.sid,
            payload: payload.payload
        };
    } catch {
        return null;
    }
}
