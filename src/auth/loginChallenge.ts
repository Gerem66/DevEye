import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

import type { LoginStep } from '@deveye/types';

import type Encryption from '@/Services/Encryption';
import { discardPendingDek } from '@/Services/SecureStore';
import { env } from '@/Utils/Env';

/**
 * Les connexions en cours, entre le mot de passe et le dernier code. En
 * mémoire : le jeton du cookie ne fait que les nommer, et un redémarrage du
 * serveur redemande le mot de passe. Un code envoyé n'y vit que condensé.
 */

/** Ce qu'un code envoyé par mail ou SMS vaut, avant d'en demander un autre. */
export const LOGIN_CODE_TTL_MS = 10 * 60_000;
/** Entre deux envois d'une même étape. */
export const LOGIN_CODE_RESEND_MS = 60_000;
/** Envois au plus par étape : au-delà, la connexion se recommence. */
export const LOGIN_CODE_MAX_SENDS = 5;
/** Codes faux tolérés sur une connexion avant de l'annuler. */
export const LOGIN_CHALLENGE_MAX_FAILURES = 5;
/** Connexions en cours par compte : deux appareils à la fois passent, une rafale non. */
const MAX_PER_USER = 5;

export interface LoginChallenge {
    id: string;
    userId: number;
    /** Les étapes restantes ; la première est celle qu'on attend. */
    steps: LoginStep[];
    /** Les étapes franchies, pour le journal. */
    passed: LoginStep[];
    /** La DEK déballée au mot de passe, rendue à la session qui s'ouvrira. */
    pendingDekToken?: string;
    /** Le code de l'étape en cours, quand elle en envoie un. */
    code: { hash: string; expiresAt: number } | null;
    sentAt: number;
    sends: number;
    failures: number;
    /** Demandé à une étape de mail ou de SMS : le navigateur sera reconnu. */
    trust: boolean;
    expiresAt: number;
}

const challenges = new Map<string, LoginChallenge>();

function drop(challenge: LoginChallenge, keepDek: boolean): void {
    challenges.delete(challenge.id);
    if (!keepDek && challenge.pendingDekToken) discardPendingDek(challenge.pendingDekToken);
}

function sweep(now: number): void {
    for (const challenge of challenges.values()) {
        if (now >= challenge.expiresAt) drop(challenge, false);
    }
}

export function openLoginChallenge(userId: number, steps: LoginStep[], pendingDekToken?: string): LoginChallenge {
    const now = Date.now();
    sweep(now);
    const mine = [...challenges.values()].filter((c) => c.userId === userId);
    for (const old of mine.slice(0, Math.max(0, mine.length - MAX_PER_USER + 1))) drop(old, false);
    const challenge: LoginChallenge = {
        id: randomBytes(18).toString('base64url'),
        userId,
        steps,
        passed: [],
        pendingDekToken,
        code: null,
        sentAt: 0,
        sends: 0,
        failures: 0,
        trust: false,
        expiresAt: now + env.LOGIN_CHALLENGE_TTL_SECONDS * 1000
    };
    challenges.set(challenge.id, challenge);
    return challenge;
}

/** La connexion en cours que nomme le jeton, si elle vit encore et appartient bien à ce compte. */
export function findLoginChallenge(id: string, userId: number): LoginChallenge | null {
    sweep(Date.now());
    const challenge = challenges.get(id);
    return challenge && challenge.userId === userId ? challenge : null;
}

/** Abandonnée (annulée, trop de codes faux) : la DEK mise de côté s'efface avec elle. */
export function abandonLoginChallenge(challenge: LoginChallenge): void {
    drop(challenge, false);
}

/** Aboutie : la DEK reste à réclamer par la session qui s'ouvre. */
export function completeLoginChallenge(challenge: LoginChallenge): void {
    drop(challenge, true);
}

/** Toutes les connexions en cours d'un compte : mot de passe changé, compte suspendu. */
export function abandonLoginChallengesOf(userId: number): void {
    for (const challenge of challenges.values()) {
        if (challenge.userId === userId) abandonLoginChallenge(challenge);
    }
}

/**
 * Le condensé d'un code envoyé, sous une clé dérivée de la clé serveur : six
 * chiffres se devinent hors ligne en un instant, une clé ne se devine pas.
 */
function hashCode(crypt: Encryption, code: string): string {
    return createHmac('sha256', crypt.derive('deveye-login-codes', 'v1', 32))
        .update(code.trim())
        .digest('hex');
}

/** Un code neuf pour l'étape en cours : le précédent ne vaut plus rien. Rend le code en clair, à envoyer. */
export function issueLoginCode(crypt: Encryption, challenge: LoginChallenge, now = Date.now()): string {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    challenge.code = { hash: hashCode(crypt, code), expiresAt: now + LOGIN_CODE_TTL_MS };
    challenge.sentAt = now;
    challenge.sends += 1;
    return code;
}

/** Le code envoyé pour l'étape en cours est-il celui-ci, et encore valable ? */
export function matchesLoginCode(
    crypt: Encryption,
    challenge: LoginChallenge,
    code: string,
    now = Date.now()
): boolean {
    if (!challenge.code || now >= challenge.code.expiresAt) return false;
    const expected = Buffer.from(challenge.code.hash, 'hex');
    const given = Buffer.from(hashCode(crypt, code), 'hex');
    return expected.length === given.length && timingSafeEqual(expected, given);
}

/** L'étape en cours est franchie, ou sautée (`passed: false`) : la suivante repart de zéro. */
export function advanceLoginChallenge(challenge: LoginChallenge, passed = true): void {
    const step = challenge.steps.shift();
    if (step && passed) challenge.passed.push(step);
    challenge.code = null;
    challenge.sentAt = 0;
    challenge.sends = 0;
}
