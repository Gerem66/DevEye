import { createHash, randomBytes } from 'node:crypto';

import { env } from '@/Utils/Env';

/** Le domaine des comptes jetables : `.invalid` est réservé (RFC 2606), rien n'y est jamais remis. */
export const TEST_MAIL_DOMAIN = 'e2e.deveye.invalid';

const TEST_ADDRESS = /^e2e-([0-9a-f]{6})-([0-9a-f]{8})-(\d{1,3})@e2e\.deveye\.invalid$/;

/** L'étiquette de ce serveur : deux serveurs sur la même base ne balaient que leurs propres comptes. */
export function instanceTag(origin: string = env.PUBLIC_ORIGIN): string {
    return createHash('sha256').update(origin.replace(/\/+$/, '')).digest('hex').slice(0, 6);
}

export function newRunId(): string {
    return randomBytes(4).toString('hex');
}

export interface TestIdentity {
    username: string;
    email: string;
    password: string;
}

export function testIdentity(runId: string, n: number): TestIdentity {
    const username = `e2e-${instanceTag()}-${runId}-${n}`;
    return { username, email: `${username}@${TEST_MAIL_DOMAIN}`, password: randomBytes(24).toString('base64url') };
}

export function isTestEmail(email: string): boolean {
    return email.trim().toLowerCase().endsWith(`@${TEST_MAIL_DOMAIN}`);
}

/** L'essai qu'une adresse d'essai désigne (`<étiquette>-<essai>`) ; `null` pour toute autre adresse. */
export function e2eRunOf(email: string): string | null {
    const m = TEST_ADDRESS.exec(email.trim().toLowerCase());
    return m ? `${m[1]}-${m[2]}` : null;
}
