import { createHmac, timingSafeEqual } from 'node:crypto';

import { normalizeRemoteOrigin, REMOTE_INSTANCES_MAX, type SessionBundle } from '@deveye/types';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { env, isDev } from '@/Utils/Env';
import { authTransport } from './federation';

/**
 * Les instances distantes du compte, à portée de la réponse qui sert le
 * DOCUMENT : c'est là que se décide sa politique de contenu, et à ce moment le
 * jeton d'accès est souvent expiré (le jeton de rafraîchissement, lui, ne
 * voyage que vers `/api/auth`). D'où un cookie à part, qui ne dit rien d'autre
 * que ces adresses.
 *
 * Signé : la page ne peut pas s'élargir sa propre politique en posant ce
 * cookie, ce que ferait un script injecté avant de faire sortir des données.
 */
export const FEDERATION_COOKIE = 'dv_fed';

const sign = (payload: string): string =>
    createHmac('sha256', env.JWT_ACCESS_SECRET).update(`dv_fed:${payload}`).digest('base64url');

export function sealFederationOrigins(origins: readonly string[]): string {
    const payload = Buffer.from(JSON.stringify(origins)).toString('base64url');
    return `${payload}.${sign(payload)}`;
}

/** Les origines d'un cookie authentique, revalidées une à une ; rien au moindre doute. */
export function openFederationOrigins(value: string | undefined): string[] {
    if (!value) return [];
    const dot = value.indexOf('.');
    if (dot === -1) return [];
    const payload = value.slice(0, dot);
    const given = Buffer.from(value.slice(dot + 1));
    const expected = Buffer.from(sign(payload));
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return [];
    try {
        const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString());
        if (!Array.isArray(parsed) || parsed.length > REMOTE_INSTANCES_MAX) return [];
        const origins = parsed.filter((o): o is string => typeof o === 'string' && normalizeRemoteOrigin(o) === o);
        return origins.length === parsed.length ? origins : [];
    } catch {
        return [];
    }
}

// `lax` et non `strict` : le document doit l'avoir même ouvert depuis un lien
// externe, sans quoi la page chargerait sous une politique qui lui interdit ses
// propres instances distantes.
const cookieOpts = () => ({
    httpOnly: true,
    secure: !isDev,
    sameSite: 'lax' as const,
    path: '/',
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {})
});

/** Aligne le cookie sur la session qu'on vient de charger. Notre page seulement. */
export function syncFederationCookie(req: FastifyRequest, reply: FastifyReply, bundle: SessionBundle): void {
    if (authTransport(req) !== 'cookie') return;
    const origins = bundle.remoteInstances.map((r) => r.origin);
    if (origins.length > 0) {
        reply.setCookie(FEDERATION_COOKIE, sealFederationOrigins(origins), {
            ...cookieOpts(),
            maxAge: env.JWT_REFRESH_TTL_SECONDS
        });
    } else if (req.cookies[FEDERATION_COOKIE]) {
        reply.clearCookie(FEDERATION_COOKIE, cookieOpts());
    }
}

export function clearFederationCookie(req: FastifyRequest, reply: FastifyReply): void {
    if (authTransport(req) === 'cookie' && req.cookies[FEDERATION_COOKIE]) {
        reply.clearCookie(FEDERATION_COOKIE, cookieOpts());
    }
}
