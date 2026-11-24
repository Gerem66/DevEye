import crypto from 'crypto';

/** Hex SHA-256 of a random token: what is stored in its place. Never for a value someone could guess. */
export function sha256hex(input: string): string {
    return crypto.createHash('sha256').update(input).digest('hex');
}
