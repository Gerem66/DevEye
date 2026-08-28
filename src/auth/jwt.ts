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

/**
 * Short-lived token proving a password check passed, pending a TOTP code.
 * `pendingDekToken` (optional) references a DEK unwrapped at login time and held
 * server-side, so the TOTP step can pre-cache it without re-prompting for the
 * password. It's only an opaque lookup key — no secret material lives in the JWT.
 */
export async function signTwoFactorChallenge(userId: number, pendingDekToken?: string): Promise<string> {
    const builder = new SignJWT(pendingDekToken ? { purpose: '2fa', pdk: pendingDekToken } : { purpose: '2fa' })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(String(userId))
        .setIssuer(issuer)
        .setAudience('deveye-2fa')
        .setIssuedAt()
        .setExpirationTime(`${env.TWOFA_CHALLENGE_TTL_SECONDS}s`);
    return builder.sign(accessSecret);
}

export async function verifyTwoFactorChallenge(
    token: string
): Promise<{ sub: string; pendingDekToken?: string } | null> {
    try {
        const { payload } = await jwtVerify(token, accessSecret, { issuer, audience: 'deveye-2fa' });
        if (typeof payload.sub !== 'string' || payload.purpose !== '2fa') return null;
        const pdk = typeof payload.pdk === 'string' ? payload.pdk : undefined;
        return { sub: payload.sub, pendingDekToken: pdk };
    } catch {
        return null;
    }
}

/**
 * Le ticket de session d'un module (`ctx.secrecy.ticket` du SDK) : ce qu'un
 * module tend au navigateur pour une route publique de son service (une URL de
 * téléchargement, un `state` OAuth), et que `deps.secrecy.redeem` lui rend
 * contre les codecs de l'appelant. Signé par l'hôte avec le secret des jetons
 * d'accès ; l'audience porte l'identifiant du module, de sorte qu'un ticket
 * n'est rendu qu'au module qui l'a émis. La charge utile est celle du module,
 * relue telle quelle ; l'identité (session, espace, compte) est celle de
 * l'hôte, que le module n'a jamais vue.
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
        const { payload } = await jwtVerify(token, accessSecret, { issuer, audience: `deveye-module:${featureId}` });
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
