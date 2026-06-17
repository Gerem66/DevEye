import { env, isDev } from '@/Utils/Env';
import type { FastifyReply } from 'fastify';

export const ACCESS_COOKIE = 'dv_at';
export const REFRESH_COOKIE = 'dv_rt';
export const TWOFA_COOKIE = 'dv_2fa';

interface BaseCookieOpts {
    httpOnly: true;
    secure: boolean;
    sameSite: 'strict';
    path: string;
    domain?: string;
}

function baseOpts(path: string): BaseCookieOpts {
    const opts: BaseCookieOpts = {
        httpOnly: true,
        secure: !isDev,
        sameSite: 'strict',
        path
    };
    if (env.COOKIE_DOMAIN) opts.domain = env.COOKIE_DOMAIN;
    return opts;
}

export function setAuthCookies(reply: FastifyReply, accessToken: string, refreshToken: string): void {
    reply.setCookie(ACCESS_COOKIE, accessToken, {
        ...baseOpts('/'),
        maxAge: env.JWT_ACCESS_TTL_SECONDS
    });
    reply.setCookie(REFRESH_COOKIE, refreshToken, {
        ...baseOpts('/api/auth'),
        maxAge: env.JWT_REFRESH_TTL_SECONDS
    });
}

export function clearAuthCookies(reply: FastifyReply): void {
    reply.clearCookie(ACCESS_COOKIE, { ...baseOpts('/') });
    reply.clearCookie(REFRESH_COOKIE, { ...baseOpts('/api/auth') });
}

export function setTwoFactorChallengeCookie(reply: FastifyReply, token: string): void {
    reply.setCookie(TWOFA_COOKIE, token, {
        ...baseOpts('/api/auth'),
        maxAge: env.TWOFA_CHALLENGE_TTL_SECONDS
    });
}

export function clearTwoFactorChallengeCookie(reply: FastifyReply): void {
    reply.clearCookie(TWOFA_COOKIE, { ...baseOpts('/api/auth') });
}
