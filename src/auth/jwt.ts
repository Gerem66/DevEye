import { env } from '@/Utils/Env';
import { randomUUID } from 'crypto';
import { SignJWT, errors as joseErrors, jwtVerify } from 'jose';

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

export interface DeviceClaims {
    sub: string; // device id
    oid: number; // owner user id
}

/** Long-lived device token. Revocation is enforced via DB status + token hash. */
export async function signDeviceToken(deviceId: string, ownerId: number): Promise<string> {
    return new SignJWT({ oid: ownerId, typ: 'device' })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(deviceId)
        .setIssuer(issuer)
        .setAudience('deveye-agent')
        .setIssuedAt()
        .sign(deviceSecret);
}

export async function verifyDeviceToken(token: string): Promise<DeviceClaims | null> {
    try {
        const { payload } = await jwtVerify(token, deviceSecret, { issuer, audience: 'deveye-agent' });
        if (typeof payload.sub !== 'string' || typeof payload.oid !== 'number') return null;
        return { sub: payload.sub, oid: payload.oid };
    } catch {
        return null;
    }
}

/** Short-lived token proving a password check passed, pending a TOTP code. */
export async function signTwoFactorChallenge(userId: number): Promise<string> {
    return new SignJWT({ purpose: '2fa' })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(String(userId))
        .setIssuer(issuer)
        .setAudience('deveye-2fa')
        .setIssuedAt()
        .setExpirationTime(`${env.TWOFA_CHALLENGE_TTL_SECONDS}s`)
        .sign(accessSecret);
}

export async function verifyTwoFactorChallenge(token: string): Promise<{ sub: string } | null> {
    try {
        const { payload } = await jwtVerify(token, accessSecret, { issuer, audience: 'deveye-2fa' });
        if (typeof payload.sub !== 'string' || payload.purpose !== '2fa') return null;
        return { sub: payload.sub };
    } catch {
        return null;
    }
}
