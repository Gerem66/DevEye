import { namePatternSchema, SHA256_PATTERN, type RuleExposure } from '../contracts/domain';

/**
 * Ce que les règles savent faire sans base : reconnaître un nom, lire une
 * liste d'empreintes collée ou téléchargée, dire si une règle couvre une
 * exposition.
 */

const REGEX_SPECIALS = /[.+^${}()|[\]\\]/g;

/**
 * Un motif de nom (`*` : une suite quelconque, `?` : un caractère) en
 * expression régulière sur le nom entier, casse ignorée : `*.torrent`
 * reconnaît `Film.TORRENT`, pas `torrent.txt`.
 */
export function nameGlobToRegex(glob: string): RegExp {
    let body = '';
    for (const char of glob) {
        if (char === '*') body += '.*';
        else if (char === '?') body += '.';
        else body += char.replace(REGEX_SPECIALS, '\\$&');
    }
    return new RegExp(`^${body}$`, 'iu');
}

export interface CompiledNameRule<T> {
    rule: T;
    test(name: string): boolean;
}

/** Compile les motifs une fois : un motif illisible ne tombe pas sur chaque fichier. */
export function compileNameRules<T extends { pattern: string }>(rules: readonly T[]): CompiledNameRule<T>[] {
    const out: CompiledNameRule<T>[] = [];
    for (const rule of rules) {
        try {
            const regex = nameGlobToRegex(rule.pattern);
            out.push({ rule, test: (name) => regex.test(name.normalize('NFC')) });
        } catch {
            // Un motif qui ne compile pas n'arrête rien plutôt que tout.
        }
    }
    return out;
}

/** Une règle `public` ne regarde pas ce qu'un compte garde pour lui ; `everywhere` regarde tout. */
export function coversExposure(rule: RuleExposure, exposure: 'public' | 'private'): boolean {
    return rule === 'everywhere' || exposure === 'public';
}

/**
 * Les empreintes d'un texte : une par ligne, en minuscules, sans doublon. Une
 * ligne en `#` est un commentaire, et une ligne de CSV ou de tableur livre le
 * premier SHA-256 qu'elle contient : les listes publiques se collent telles
 * quelles.
 */
export function parseFingerprints(text: string): { fingerprints: string[]; ignored: number } {
    const found = new Set<string>();
    let ignored = 0;
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (line.length === 0 || line.startsWith('#')) continue;
        const match = /[A-Fa-f0-9]{64}/.exec(line);
        const candidate = match === null ? null : match[0].toLowerCase();
        // Un condensat plus long (un SHA-512) contient 64 hexadécimaux : il n'est pas une empreinte.
        if (candidate === null || /[A-Fa-f0-9]{65}/.test(line) || !SHA256_PATTERN.test(candidate)) {
            ignored += 1;
            continue;
        }
        if (found.has(candidate)) ignored += 1;
        else found.add(candidate);
    }
    return { fingerprints: [...found], ignored };
}

/**
 * Les motifs de nom d'un texte, un par ligne, sans doublon (casse ignorée).
 * Une ligne vide ou en `#` est sautée ; une ligne qui n'est pas un motif
 * arrête la lecture et dit laquelle : un motif tapé à la main ne s'ignore pas
 * en silence, à la différence d'une liste d'empreintes collée.
 */
export function parseNamePatterns(text: string): {
    patterns: string[];
    ignored: number;
    problem: { line: number; message: string } | null;
} {
    const seen = new Set<string>();
    const patterns: string[] = [];
    let ignored = 0;
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index].trim();
        if (line.length === 0 || line.startsWith('#')) continue;
        const parsed = namePatternSchema.safeParse(line);
        if (!parsed.success) {
            return {
                patterns,
                ignored,
                problem: { line: index + 1, message: parsed.error.issues[0]?.message ?? 'motif invalide' }
            };
        }
        const key = parsed.data.normalize('NFC').toLowerCase();
        if (seen.has(key)) ignored += 1;
        else {
            seen.add(key);
            patterns.push(parsed.data);
        }
    }
    return { patterns, ignored, problem: null };
}

/** Le nom d'un fichier dans un chemin, quel que soit le séparateur. */
export function baseNameOf(path: string): string {
    const parts = path.split(/[/\\]/).filter((part) => part.length > 0);
    return parts[parts.length - 1] ?? path;
}
