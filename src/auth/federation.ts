import type { FastifyRequest } from 'fastify';

import { env, isDev } from '@/Utils/Env';
import { ACCESS_COOKIE } from './cookies';

/**
 * La fédération : la page d'une AUTRE instance DevEye ouvre une session ici,
 * depuis le navigateur de l'utilisateur. Les deux serveurs ne se parlent jamais.
 *
 * Une telle page ne peut pas tenir nos cookies (`SameSite=strict`, autre site) :
 * sa session est « au porteur », jetons dans le corps des réponses, jeton d'accès
 * en `Authorization`. C'est aussi ce qui la rend sûre : aucune de ses requêtes ne
 * porte d'identifiant ambiant, donc une page tierce ne peut rien faire au nom de
 * l'utilisateur sans qu'il lui ait tapé son mot de passe.
 */

const trimOrigin = (origin: string): string => origin.trim().replace(/\/+$/, '');

let listed = new Set<string>();
let wildcard = false;

function load(raw: string | undefined): void {
    const entries = (raw ?? '').split(',').map(trimOrigin).filter(Boolean);
    wildcard = entries.includes('*');
    listed = new Set(entries.filter((e) => e !== '*'));
}
load(env.FEDERATION_ORIGINS);

export function setFederationOriginsForTest(raw: string | undefined): void {
    load(raw);
}

export function federationEnabled(): boolean {
    return wildcard || listed.size > 0;
}

export function isFederatedOrigin(origin: string | undefined): boolean {
    if (!origin || trimOrigin(origin) === trimOrigin(env.PUBLIC_ORIGIN)) return false;
    if (listed.has(trimOrigin(origin))) return true;
    // Hors dev : là, notre propre page vient de Vite, dont l'origine n'est pas
    // `PUBLIC_ORIGIN`, et `*` la prendrait pour une instance étrangère.
    return wildcard && !isDev;
}

/** Un navigateur envoie toujours `Origin` sur une requête d'une autre origine. */
export function federatedOriginOf(req: FastifyRequest): string | null {
    const origin = req.headers.origin;
    return isFederatedOrigin(origin) ? (origin as string) : null;
}

export type AuthTransport = 'cookie' | 'bearer';

export function authTransport(req: FastifyRequest): AuthTransport {
    return federatedOriginOf(req) ? 'bearer' : 'cookie';
}

/**
 * Le jeton d'accès de la requête, par le seul canal de son transport : une
 * origine fédérée n'est jamais servie sur la foi d'un cookie (deux instances
 * sous un même domaine parent partageraient les leurs), ni notre page sur la
 * foi d'un en-tête.
 */
export function readAccessToken(req: FastifyRequest): string | undefined {
    if (authTransport(req) === 'cookie') return req.cookies[ACCESS_COOKIE];
    const header = req.headers.authorization;
    return header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() || undefined : undefined;
}
