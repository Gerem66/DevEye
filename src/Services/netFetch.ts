/**
 * Primitives d'accès au réseau public, partagées par tout ce qui va chercher
 * quelque chose dehors : un garde SSRF écrit deux fois est un garde qu'on
 * corrigera une fois. Tout appel sortant vers une adresse qu'un membre a pu
 * choisir passe par {@link safeFetch} ; `fetchJson` et `fetchHtmlCapped` en
 * sont des habillages.
 *
 * Le garde d'URL vit dans `@deveye/types/sdk/server`, d'où un module externe
 * peut l'atteindre : l'app ne l'importe pas deux fois.
 */
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns';

import { isPublicIp, isSafePublicUrl } from '@deveye/types/sdk/server';
import { Agent, fetch as undiciFetch, type RequestInit, type Response } from 'undici';

import { env } from '@/Utils/Env';

export { isPublicIp, isSafePublicUrl };

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

let allowPrivate = env.OUTBOUND_ALLOW_PRIVATE;

/** Un test qui monte un vrai serveur local ouvre la boucle locale le temps de sa suite. */
export function setAllowPrivateForTest(value: boolean): void {
    allowPrivate = value;
}

/** 169.254.0.0/16 et fe80::/10 : les métadonnées cloud y vivent, aucune cible légitime. */
function isLinkLocal(address: string): boolean {
    const ip = address.replace(/^\[|\]$/g, '').toLowerCase();
    return /^169\.254\./.test(ip) || /^::ffff:169\.254\./.test(ip) || /^fe[89ab]/.test(ip);
}

/** L'adresse jointe est-elle permise par le réglage de l'instance ? */
function isAllowedAddress(address: string): boolean {
    if (isLinkLocal(address)) return false;
    return allowPrivate || isPublicIp(address);
}

/**
 * Le serveur peut-il appeler cette URL, choisie par un membre ? Par défaut, les
 * seuls hôtes http(s) publics ; avec `OUTBOUND_ALLOW_PRIVATE`, tout hôte http(s)
 * hors lien-local. À vérifier à l'écriture (le membre voit le refus) ;
 * {@link safeFetch} le revérifie à chaque appel.
 */
export function isAllowedOutboundUrl(input: URL | string): boolean {
    if (!allowPrivate) return isSafePublicUrl(input);
    let u: URL;
    try {
        u = typeof input === 'string' ? new URL(input) : input;
    } catch {
        return false;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return !isLinkLocal(u.hostname);
}

/** Le refus d'une cible, en une phrase que le membre peut suivre. */
export const OUTBOUND_REFUSED_MESSAGE =
    'Cette adresse n’est pas joignable depuis le serveur : seules les adresses http(s) publiques sont permises ' +
    '(une installation personnelle peut ouvrir son réseau privé avec OUTBOUND_ALLOW_PRIVATE).';

/**
 * La résolution DNS de toute connexion sortante vers une adresse qu'un membre a
 * saisie : une adresse non permise est refusée au moment de se connecter. Le
 * garde d'URL ne voit qu'un nom, et un nom public peut pointer sur 127.0.0.1
 * (ou y repointer entre la vérification et la connexion) : c'est ici, et ici
 * seulement, que la règle est vraie.
 */
export function publicLookup(hostname: string, options: LookupOptions, callback: LookupCallback): void {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
        if (err) return callback(err, []);
        const list = addresses as LookupAddress[];
        const blocked = list.find((a) => !isAllowedAddress(a.address));
        if (blocked || list.length === 0) {
            const refused = new Error(`Adresse non permise pour ${hostname}`) as NodeJS.ErrnoException;
            refused.code = 'ENOTPUBLIC';
            return callback(refused, []);
        }
        if (options.all) return callback(null, list);
        callback(null, list[0].address, list[0].family);
    });
}

const publicAgent = new Agent({ connect: { lookup: publicLookup as never } });

const MAX_REDIRECTS = 5;

type Transport = (url: string, init: RequestInit) => Promise<Response>;

const networkTransport: Transport = (url, init) => undiciFetch(url, { ...init, dispatcher: publicAgent });
let transport: Transport = networkTransport;

/** Un test remplace le réseau le temps de sa suite ; `null` le rétablit. Les gardes d'URL restent actifs. */
export function setSafeFetchTransportForTest(fake: Transport | null): void {
    transport = fake ?? networkTransport;
}

/** Une cible refusée par le garde, à distinguer d'une panne réseau. */
export class UnsafeTargetError extends Error {
    constructor() {
        super(OUTBOUND_REFUSED_MESSAGE);
        this.name = 'UnsafeTargetError';
    }
}

/**
 * `fetch` vers une adresse saisie par un membre. Trois gardes, parce qu'un seul
 * ne suffit pas : l'URL (schéma, nom, IP littérale), chaque saut de redirection
 * revérifié (un hôte public peut rediriger vers le réseau interne), et l'adresse
 * réellement jointe ({@link publicLookup}). `redirect` vaut `'follow'` par
 * défaut ; `'manual'` rend la 3xx telle quelle.
 */
export async function safeFetch(
    input: string | URL,
    init: Omit<RequestInit, 'dispatcher'> & { redirect?: 'follow' | 'manual' } = {}
): Promise<Response> {
    const follow = (init.redirect ?? 'follow') === 'follow';
    let url = typeof input === 'string' ? input : input.toString();
    let method = init.method;
    let body = init.body;
    for (let hop = 0; ; hop++) {
        if (!isAllowedOutboundUrl(url)) throw new UnsafeTargetError();
        const res = await transport(url, { ...init, method, body, redirect: 'manual' });
        const location = res.headers.get('location');
        if (!follow || res.status < 300 || res.status >= 400 || !location) return res;
        if (hop >= MAX_REDIRECTS) throw new Error('Trop de redirections');
        await res.body?.cancel();
        url = new URL(location, url).toString();
        // 303, et 301/302 sur un POST : le navigateur repart en GET sans corps.
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method?.toUpperCase() === 'POST')) {
            method = 'GET';
            body = undefined;
        }
    }
}

export const FETCH_TIMEOUT_MS = 4500;

export const BROWSER_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Branded site icon for any host, via Google's favicon service (no fetch). */
export function faviconUrl(host: string): string {
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
}

export function fmtCount(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
    return String(n);
}

/** Compact relative age of an ISO date (e.g. "3j", "2 sem", "5 mo", "1 an"). */
export function relativeShort(iso: string): string | null {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return null;
    const days = Math.floor((Date.now() - t) / 86_400_000);
    if (days <= 0) return 'auj.';
    if (days < 7) return `${days} j`;
    if (days < 31) return `${Math.floor(days / 7)} sem`;
    if (days < 365) return `${Math.floor(days / 30)} mo`;
    const y = Math.floor(days / 365);
    return `${y} an${y > 1 ? 's' : ''}`;
}

export function isValidHttpUrl(s: string): boolean {
    try {
        const u = new URL(s);
        return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
        return false;
    }
}

/**
 * Cette adresse IP est-elle routable publiquement ? Couvre boucle locale,
 * RFC 1918, lien-local, CGNAT, en v4 comme en v6, y compris la forme
 * IPv4-mappée (`::ffff:10.0.0.1`) par laquelle un filtre naïf se contourne.
 */
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };

export function decodeEntities(s: string): string {
    return s
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
        .replace(/&([a-z0-9#]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m)
        .trim();
}

/** Extract a `<meta property|name="prop" content="...">` value, if present. */
export function metaTag(html: string, prop: string): string | null {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*>`, 'i');
    const tag = html.match(re)?.[0];
    const content = tag?.match(/content=["']([^"']*)["']/i)?.[1];
    return content ? decodeEntities(content) : null;
}

export function titleTag(html: string): string | null {
    const t = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1];
    return t ? decodeEntities(t) : null;
}

/** Fetch JSON from a public API (timeout + browser UA). Throws on non-2xx. */
export async function fetchJson<T>(
    url: string,
    headers: Record<string, string> = {},
    timeoutMs: number = FETCH_TIMEOUT_MS
): Promise<T> {
    const res = await safeFetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: 'application/json', 'user-agent': 'DevEye-Dashboard', ...headers }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
}

/** Fetch a page's HTML, capped in size and time (OG tags live in <head>). */
export async function fetchHtmlCapped(url: string, maxBytes = 262_144): Promise<string> {
    const res = await safeFetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
            // A real browser UA + consent cookies: many sites (Google/YouTube in
            // particular) otherwise serve a minimal bot page or an EU cookie-
            // consent interstitial whose OG tags are generic, not the target's.
            // `SOCS`/`CONSENT` skip Google's consent gate; `PREF=hl=en` forces
            // English so scraped labels (e.g. "subscribers") are predictable.
            'user-agent': BROWSER_UA,
            accept: 'text/html,application/xhtml+xml',
            'accept-language': 'en-US,en;q=0.9',
            cookie: 'SOCS=CAI; CONSENT=YES+1; PREF=hl=en'
        }
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const ct = res.headers.get('content-type') ?? '';
    if (ct && !/text\/html|application\/xhtml/i.test(ct)) throw new Error('not html');

    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
            chunks.push(value);
            total += value.length;
            if (total >= maxBytes) {
                await reader.cancel();
                break;
            }
        }
    }
    return Buffer.concat(chunks).toString('utf8');
}
