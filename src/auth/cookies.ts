import { env, isDev } from '@/Utils/Env';
import type { FastifyReply } from 'fastify';

import { TRUSTED_BROWSER_DAYS } from '@deveye/types';

export const ACCESS_COOKIE = 'dv_at';
export const REFRESH_COOKIE = 'dv_rt';
/** Une connexion en cours, entre le mot de passe et le dernier code. */
export const LOGIN_CHALLENGE_COOKIE = 'dv_lc';
/** Les jetons des comptes qui font confiance à ce navigateur, séparés par des points. */
export const TRUSTED_BROWSER_COOKIE = 'dv_tb';

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

export function setLoginChallengeCookie(reply: FastifyReply, token: string): void {
    reply.setCookie(LOGIN_CHALLENGE_COOKIE, token, {
        ...baseOpts('/api/auth'),
        maxAge: env.LOGIN_CHALLENGE_TTL_SECONDS
    });
}

export function clearLoginChallengeCookie(reply: FastifyReply): void {
    reply.clearCookie(LOGIN_CHALLENGE_COOKIE, { ...baseOpts('/api/auth') });
}

/** Reposé à chaque connexion qui le lit : sa durée suit le dernier usage. */
export function setTrustedBrowserCookie(reply: FastifyReply, tokens: readonly string[]): void {
    if (tokens.length === 0) {
        reply.clearCookie(TRUSTED_BROWSER_COOKIE, { ...baseOpts('/api/auth') });
        return;
    }
    reply.setCookie(TRUSTED_BROWSER_COOKIE, tokens.join('.'), {
        ...baseOpts('/api/auth'),
        maxAge: TRUSTED_BROWSER_DAYS * 86400
    });
}
