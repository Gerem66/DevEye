import { env } from '@/Utils/Env';
import { randomUUID } from 'crypto';
import { SignJWT, errors as joseErrors, jwtVerify } from 'jose';

const issuer = 'deveye';
const audience = 'deveye-client';

const accessSecret = new TextEncoder().encode(env.JWT_ACCESS_SECRET);
const refreshSecret = new TextEncoder().encode(env.JWT_REFRESH_SECRET);

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
        const { payload } = await jwtVerify(token, accessSecret, { issuer, audience });
        if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') return null;
        return { sub: payload.sub, sid: payload.sid };
    } catch (e) {
        if (e instanceof joseErrors.JWTExpired || e instanceof joseErrors.JWTInvalid) return null;
        return null;
    }
}

export async function verifyRefreshToken(token: string): Promise<RefreshClaims | null> {
    try {
        const { payload } = await jwtVerify(token, refreshSecret, { issuer, audience });
        if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string' || typeof payload.jti !== 'string') {
            return null;
        }
        return { sub: payload.sub, sid: payload.sid, jti: payload.jti };
    } catch {
        return null;
    }
}
