import { env } from '@/Utils/Env';
import { randomUUID } from 'crypto';
import { SignJWT, errors as joseErrors, jwtVerify } from 'jose';
import type { MailOAuthProvider, MailSecurityTier } from '@deveye/types';

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

export interface MailOAuthStateClaims {
    userId: number;
    /** Espace dans lequel le compte mail sera créé — le callback n'a pas de contexte pour le déduire. */
    workspaceId: number;
    /** WS session id, so the callback route can reach the same live DEK for a "guarded" account. */
    sessionId: string;
    provider: MailOAuthProvider;
    securityTier: MailSecurityTier;
}

/**
 * Short-lived state carried through the Google/Microsoft consent redirect —
 * the callback route is a plain HTTP GET with no WS context of its own, so
 * everything it needs to finish the flow (which user, which workspace, which
 * live session's DEK to use if "guarded", which provider/tier) travels signed
 * in `state`
 * rather than being guessed from cookies alone.
 */
export async function signMailOAuthState(claims: MailOAuthStateClaims): Promise<string> {
    return new SignJWT({ ...claims, purpose: 'mail-oauth' })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer(issuer)
        .setAudience('deveye-mail-oauth')
        .setIssuedAt()
        .setExpirationTime('10m')
        .sign(accessSecret);
}

export interface MailAttachmentClaims {
    messageId: number;
    attachmentId: string;
    userId: number;
    /** Espace qui porte le compte : c'est lui qui cloisonne la lecture et qui indexe la clé, pas l'utilisateur. */
    workspaceId: number;
    sessionId: string;
}

/** Short-lived token backing `mail.attachmentDownload`'s signed URL — minted just before the client fetches it. */
export async function signMailAttachmentToken(claims: MailAttachmentClaims): Promise<string> {
    return new SignJWT({ ...claims, purpose: 'mail-attachment' })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer(issuer)
        .setAudience('deveye-mail-attachment')
        .setIssuedAt()
        .setExpirationTime('2m')
        .sign(accessSecret);
}

export async function verifyMailAttachmentToken(token: string): Promise<MailAttachmentClaims | null> {
    try {
        const { payload } = await jwtVerify(token, accessSecret, { issuer, audience: 'deveye-mail-attachment' });
        if (
            payload.purpose !== 'mail-attachment' ||
            typeof payload.messageId !== 'number' ||
            typeof payload.attachmentId !== 'string' ||
            typeof payload.userId !== 'number' ||
            typeof payload.workspaceId !== 'number' ||
            typeof payload.sessionId !== 'string'
        ) {
            return null;
        }
        return {
            messageId: payload.messageId,
            attachmentId: payload.attachmentId,
            userId: payload.userId,
            workspaceId: payload.workspaceId,
            sessionId: payload.sessionId
        };
    } catch {
        return null;
    }
}

export async function verifyMailOAuthState(token: string): Promise<MailOAuthStateClaims | null> {
    try {
        const { payload } = await jwtVerify(token, accessSecret, { issuer, audience: 'deveye-mail-oauth' });
        if (
            payload.purpose !== 'mail-oauth' ||
            typeof payload.userId !== 'number' ||
            typeof payload.workspaceId !== 'number' ||
            typeof payload.sessionId !== 'string' ||
            (payload.provider !== 'google' && payload.provider !== 'microsoft') ||
            (payload.securityTier !== 'open' && payload.securityTier !== 'guarded')
        ) {
            return null;
        }
        return {
            userId: payload.userId,
            workspaceId: payload.workspaceId,
            sessionId: payload.sessionId,
            provider: payload.provider,
            securityTier: payload.securityTier
        };
    } catch {
        return null;
    }
}
