import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * Les clés publiques des mises à jour, une par ligne : la première est celle
 * que l'agent grave à sa compilation (`agent/build.rs`), une seconde est
 * l'ancienne pendant une rotation (`Docs/KEY_ROTATION.md`). Le serveur vérifie
 * avec elles ce qu'il sert : un binaire dont la signature ne tient pas n'est ni
 * gardé ni poussé, quel que soit le manifeste qui l'annonce.
 */
const PUBLIC_KEY_FILE = new URL('../../agent/update-signing.pub', import.meta.url);

let cached: KeyObject[] | undefined;

/** Vide sans fichier de clé : un build qui n'en a pas ne vérifie rien, comme l'agent du même build. */
export function updateSigningKeys(): KeyObject[] {
    if (cached !== undefined) return cached;
    let lines: string[];
    try {
        lines = readFileSync(PUBLIC_KEY_FILE, 'utf8').split('\n');
    } catch {
        lines = [];
    }
    cached = lines
        .map((line) => Buffer.from(line.trim(), 'base64'))
        .filter((raw) => raw.length === 32)
        .map((raw) =>
            createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' })
        );
    return cached;
}

/** La signature Ed25519 de la CI porte sur les 32 octets de l'empreinte SHA-256 (`agent/src/sign.rs`). */
export function signatureHolds(
    keys: readonly KeyObject[],
    sha256Hex: string,
    signatureB64: string | null | undefined
): boolean {
    if (!signatureB64 || !/^[0-9a-f]{64}$/i.test(sha256Hex)) return false;
    const signature = Buffer.from(signatureB64, 'base64');
    if (signature.length !== 64) return false;
    const digest = Buffer.from(sha256Hex, 'hex');
    return keys.some((key) => {
        try {
            return verify(null, digest, key, signature);
        } catch {
            return false;
        }
    });
}
