import { randomInt, scrypt, timingSafeEqual, randomBytes } from 'node:crypto';

import {
    normaliseDomainHost,
    type FeatureServiceDeps,
    type SdkCipher,
    type SdkFeatureContext,
    type SdkOrigins
} from '@deveye/types/sdk/server';
import { z } from 'zod';

import {
    EMPTY_UTM,
    SHORTLINK_CODE_ALPHABET,
    SHORTLINK_CODE_LENGTH,
    SHORTLINKS_PATH,
    type ShortlinkTargets,
    type ShortlinkUtm
} from '../contracts/domain';
import { env } from './env';
import type { LinkRow, ShortlinksRepo } from './repo';

export type Ctx = SdkFeatureContext<ShortlinksRepo>;

export const DAY = 86_400;

export const now = (): number => Math.floor(Date.now() / 1000);

/** Le jour UTC d'un instant, en jours depuis 1970 : la clé des tables de chiffres. */
export const dayOf = (seconds: number): number => Math.floor(seconds / DAY);

/** Le mois UTC d'un instant, `AAAA-MM` : la clé de l'usage. */
export function monthOf(seconds: number): string {
    const date = new Date(seconds * 1000);
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Ce qu'un lien garde sous scellé, à l'étage ouvert. */
export const linkContentSchema = z.object({
    title: z.string(),
    targets: z.object({ default: z.string(), ios: z.string().nullable(), android: z.string().nullable() }),
    utm: z.object({
        source: z.string(),
        medium: z.string(),
        campaign: z.string(),
        term: z.string(),
        content: z.string()
    })
});
export type LinkContent = z.infer<typeof linkContentSchema>;

/** Un contenu illisible garde le lien listable et supprimable ; sans destination, il ne redirige plus. */
export const EMPTY_CONTENT: LinkContent = {
    title: '',
    targets: { default: '', ios: null, android: null },
    utm: EMPTY_UTM
};

export function sealContent(cipher: SdkCipher, content: LinkContent): Promise<string> {
    return cipher.encrypt(JSON.stringify(content));
}

export async function openContent(cipher: SdkCipher, blob: string): Promise<LinkContent> {
    const plain = await cipher.tryDecrypt(blob);
    if (plain === null) return EMPTY_CONTENT;
    try {
        const parsed = linkContentSchema.safeParse(JSON.parse(plain));
        return parsed.success ? parsed.data : EMPTY_CONTENT;
    } catch {
        return EMPTY_CONTENT;
    }
}

export function newCode(): string {
    let code = '';
    for (let i = 0; i < SHORTLINK_CODE_LENGTH; i++)
        code += SHORTLINK_CODE_ALPHABET[randomInt(SHORTLINK_CODE_ALPHABET.length)];
    return code;
}

export function isDuplicate(error: unknown): boolean {
    const bag = error as { code?: unknown; errno?: unknown } | null;
    return bag?.code === 'ER_DUP_ENTRY' || bag?.errno === 1062;
}

// ── Les adresses ───────────────────────────────────────────────────────────

const trimSlash = (origin: string) => origin.replace(/\/+$/, '');

/** Le domaine court de l'instance, quand il est posé. */
export const SHORT_ORIGIN: string | null = env.SHORTLINKS_ORIGIN ? trimSlash(env.SHORTLINKS_ORIGIN) : null;
export const SHORT_HOST: string | null = SHORT_ORIGIN === null ? null : normaliseDomainHost(new URL(SHORT_ORIGIN).host);

/** L'adresse d'un lien sur DevEye : à la racine du domaine court, sinon sous `/l/` de l'adresse publique. */
export function shortUrlOf(origins: SdkOrigins, code: string): string {
    return SHORT_ORIGIN === null ? `${origins.public}${SHORTLINKS_PATH}/${code}` : `${SHORT_ORIGIN}/${code}`;
}

/** L'adresse d'un lien sur un domaine de l'espace ; l'alias vide est la racine. */
export function domainUrlOf(host: string, slug: string): string {
    return slug === '' ? `https://${host}/` : `https://${host}/${slug}`;
}

/** Les noms que DevEye sert lui-même : une destination qui y mène bouclerait. */
export function instanceHosts(origins: SdkOrigins): string[] {
    const hosts = [origins.app, origins.public].map((origin) => normaliseDomainHost(new URL(origin).host));
    if (SHORT_HOST !== null) hosts.push(SHORT_HOST);
    return hosts;
}

// ── La redirection ─────────────────────────────────────────────────────────

/** L'appareil d'un visiteur, tel que la destination le choisit. */
export type TargetDevice = 'ios' | 'android' | 'other';

export function deviceOfAgent(userAgent: string): TargetDevice {
    if (/\biPhone\b|\biPad\b|\biPod\b/.test(userAgent)) return 'ios';
    if (/\bAndroid\b/.test(userAgent)) return 'android';
    return 'other';
}

/** La destination d'un appareil, paramètres de campagne compris : ceux du lien remplacent ceux du même nom. */
export function destinationOf(
    targets: ShortlinkTargets | LinkContent['targets'],
    utm: ShortlinkUtm,
    device: TargetDevice
): string | null {
    const base = (device === 'ios' && targets.ios) || (device === 'android' && targets.android) || targets.default;
    if (!base) return null;
    let url: URL;
    try {
        url = new URL(base);
    } catch {
        return null;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    for (const [key, value] of Object.entries(utm)) {
        if (value) url.searchParams.set(`utm_${key}`, value);
    }
    return url.toString();
}

// ── Le mot de passe d'un lien ──────────────────────────────────────────────

const SCRYPT_COST = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SCRYPT_BYTES = 32;

function scryptOf(password: string, salt: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) =>
        scrypt(password.normalize('NFC'), salt, SCRYPT_BYTES, SCRYPT_COST, (error, key) =>
            error ? reject(error) : resolve(key)
        )
    );
}

export async function hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16);
    const hash = await scryptOf(password, salt);
    return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
    const [scheme, salt, hash] = stored.split('$');
    if (scheme !== 'scrypt' || !salt || !hash) return false;
    const expected = Buffer.from(hash, 'base64url');
    const actual = await scryptOf(password, Buffer.from(salt, 'base64url'));
    return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// ── L'état d'un lien ───────────────────────────────────────────────────────

/** Expiré : sa date est passée, ou ses visites sont épuisées (en attente comprises). */
export function isExpired(
    row: Pick<LinkRow, 'expires_at' | 'max_visits' | 'visits_total'>,
    at: number,
    pending = 0
): boolean {
    if (row.expires_at !== null && Number(row.expires_at) <= at) return true;
    return row.max_visits !== null && Number(row.visits_total) + pending >= Number(row.max_visits);
}

// ── Ce que le service tient en mémoire ─────────────────────────────────────

/**
 * Ce que les commandes demandent au service : oublier un lien après une
 * écriture, le revérifier, connaître les visites pas encore écrites, et
 * prévenir un autre espace que celui de l'appelant (la modération).
 */
export interface ShortlinksRuntime {
    forget(linkId: number): void;
    checkNow(row: LinkRow): Promise<void>;
    pendingLinkVisits(linkId: number): number;
    deps: Pick<FeatureServiceDeps<ShortlinksRepo>, 'deveyeFor' | 'accountMail' | 'live' | 'geo'>;
}

let runtimeRef: ShortlinksRuntime | null = null;

export function setRuntime(runtime: ShortlinksRuntime | null): void {
    runtimeRef = runtime;
}

/** Sans service (tests), rien n'est en cache et rien n'attend. */
export const runtime = (): ShortlinksRuntime | null => runtimeRef;
