import type { MailBackupFlag, MailBackupMessage } from '@deveye/types/sdk';

/**
 * La disposition Maildir++, celle de Dovecot et de docker-mailserver : une
 * archive qu'on dépose dans le dossier mail d'un serveur IMAP courant, et
 * qu'il sert telle quelle, dossiers, drapeaux et mots-clés compris.
 */

/** Un nom de boîte IMAP en UTF-7 modifié (RFC 3501, 5.1.3), comme Dovecot l'écrit sur le disque. */
export function encodeMailboxName(name: string): string {
    let out = '';
    let run = '';
    const flush = (): void => {
        if (run === '') return;
        const utf16 = Buffer.alloc(run.length * 2);
        for (let i = 0; i < run.length; i += 1) utf16.writeUInt16BE(run.charCodeAt(i), i * 2);
        out += `&${utf16.toString('base64').replace(/=+$/, '').replace(/\//g, ',')}-`;
        run = '';
    };
    for (const char of name) {
        const code = char.codePointAt(0) ?? 0;
        if (code >= 0x20 && code <= 0x7e) {
            flush();
            out += char === '&' ? '&-' : char;
        } else {
            run += char;
        }
    }
    flush();
    return out;
}

export interface MaildirFolder {
    /** Le dossier sous la racine de la boîte : `''` pour INBOX, `.Envoy&AOk-s` sinon. */
    dir: string;
    /** Le nom que liste le fichier `subscriptions`. */
    name: string;
    /** Un point du nom d'origine a dû devenir `_`. */
    renamed: boolean;
}

/** INBOX est la racine ; un autre dossier `A/B` devient `.A.B`, le point étant le séparateur. */
export function maildirFolder(path: string): MaildirFolder {
    if (path === 'INBOX') return { dir: '', name: 'INBOX', renamed: false };
    let renamed = false;
    const segments = path.split('/').map((segment) => {
        if (segment.includes('.')) renamed = true;
        return encodeMailboxName(segment.replace(/\./g, '_'));
    });
    const name = segments.join('.');
    return { dir: `.${name}`, name, renamed };
}

/** Les lettres de drapeau d'un nom de fichier Maildir. */
const FLAG_LETTERS: Record<MailBackupFlag, string> = {
    draft: 'D',
    flagged: 'F',
    answered: 'R',
    seen: 'S',
    deleted: 'T'
};

/** Dovecot n'attribue que les 26 minuscules aux mots-clés d'un dossier. */
export const MAILDIR_KEYWORDS_MAX = 26;

export interface KeywordTable {
    letters: ReadonlyMap<string, string>;
    /** Le contenu de `dovecot-keywords`, `''` sans mot-clé. */
    file: string;
    /** Les mots-clés au-delà des 26 lettres, perdus pour ce dossier. */
    dropped: number;
}

export function keywordTable(keywords: readonly string[]): KeywordTable {
    const kept = keywords.slice(0, MAILDIR_KEYWORDS_MAX);
    return {
        letters: new Map(kept.map((keyword, index) => [keyword, String.fromCharCode(0x61 + index)])),
        file: kept.map((keyword, index) => `${index} ${keyword}\n`).join(''),
        dropped: keywords.length - kept.length
    };
}

/**
 * `<date>.M<id>.deveye,S=<taille>:2,<drapeaux>` : unique dans la boîte, la
 * taille épargne à Dovecot de la relire, et les lettres suivent l'ordre ASCII
 * qu'il exige (drapeaux en majuscules, puis mots-clés).
 */
export function maildirFileName(message: MailBackupMessage, letters: ReadonlyMap<string, string>): string {
    const marks = [
        ...message.flags.map((flag) => FLAG_LETTERS[flag]),
        ...message.keywords.flatMap((keyword) => letters.get(keyword) ?? [])
    ].sort();
    return `${message.internalDate}.M${message.id}.deveye,S=${message.size}:2,${marks.join('')}`;
}
