import crypto from 'crypto';

/** Hex SHA-256, used for token hashes and 2FA backup-code storage. */
export function sha256hex(input: string): string {
    return crypto.createHash('sha256').update(input).digest('hex');
}
