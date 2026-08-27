export interface PasswordGeneratorOptions {
    length: number;
    uppercase: boolean;
    lowercase: boolean;
    digits: boolean;
    symbols: boolean;
}

export const DEFAULT_GENERATOR_OPTIONS: PasswordGeneratorOptions = {
    length: 16,
    uppercase: true,
    lowercase: true,
    digits: true,
    symbols: true
};

export const GENERATOR_LENGTH_MIN = 8;
export const GENERATOR_LENGTH_MAX = 64;

type CharsetKey = 'uppercase' | 'lowercase' | 'digits' | 'symbols';

const CHARSETS: Record<CharsetKey, string> = {
    uppercase: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    lowercase: 'abcdefghijklmnopqrstuvwxyz',
    digits: '0123456789',
    symbols: '!@#$%^&*()-_=+[]{}?'
};

function randomIndex(max: number): number {
    const arr = new Uint32Array(1);
    crypto.getRandomValues(arr);
    return arr[0] % max;
}

/** True once at least one character type is enabled: a generator with none selected has no pool to draw from. */
export function hasSelectedCharset(options: PasswordGeneratorOptions): boolean {
    return options.uppercase || options.lowercase || options.digits || options.symbols;
}

/**
 * Draws a random password from `crypto.getRandomValues`, guaranteeing at least
 * one character of each selected type (then filling/shuffling the rest) so
 * short lengths don't accidentally skip an enabled charset.
 */
export function generatePassword(options: PasswordGeneratorOptions): string {
    const keys = (Object.keys(CHARSETS) as CharsetKey[]).filter((key) => options[key]);
    if (keys.length === 0) return '';

    const pool = keys.map((key) => CHARSETS[key]).join('');
    const length = Math.max(1, Math.floor(options.length));

    const required = keys.map((key) => CHARSETS[key][randomIndex(CHARSETS[key].length)]);
    const rest = Array.from({ length: Math.max(0, length - required.length) }, () => pool[randomIndex(pool.length)]);
    const chars = [...required, ...rest].slice(0, length);

    for (let i = chars.length - 1; i > 0; i--) {
        const j = randomIndex(i + 1);
        [chars[i], chars[j]] = [chars[j], chars[i]];
    }

    return chars.join('');
}
