import { dayOfDate } from '../days';

/**
 * Les tableaux que rendent les stores : décodage, découpe, et lecture de
 * cellules qui tolère ce qu'un export de console écrit (« NA », « 1,234 »).
 * Les colonnes se trouvent par leur nom d'en-tête, jamais par leur rang : les
 * stores en ajoutent sans prévenir.
 */

export interface Table {
    header: string[];
    rows: string[][];
}

/**
 * Le texte d'un fichier : UTF-16 (les rapports de Google Play) ou UTF-8, selon
 * sa marque d'ordre, ou à défaut selon les octets nuls d'un texte ASCII en UTF-16.
 */
export function decodeText(bytes: Uint8Array): string {
    let encoding = 'utf-8';
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
    else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';
    else if (bytes.length >= 4 && bytes[0] !== 0 && bytes[1] === 0 && bytes[2] !== 0 && bytes[3] === 0) {
        encoding = 'utf-16le';
    }
    return new TextDecoder(encoding).decode(bytes).replace(/^\uFEFF/, '');
}

/**
 * Un CSV selon la RFC 4180 : champs entre guillemets, guillemets doublés,
 * retours à la ligne dans un champ cité. Les lignes vides sont écartées.
 */
export function parseCsv(text: string, delimiter = ','): Table {
    const records: string[][] = [];
    let record: string[] = [];
    let field = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quoted) {
            if (c === '"') {
                if (text[i + 1] === '"') {
                    field += '"';
                    i++;
                } else quoted = false;
            } else field += c;
            continue;
        }
        if (c === '"') quoted = true;
        else if (c === delimiter) {
            record.push(field);
            field = '';
        } else if (c === '\n' || c === '\r') {
            if (c === '\r' && text[i + 1] === '\n') i++;
            record.push(field);
            records.push(record);
            record = [];
            field = '';
        } else field += c;
    }
    if (field !== '' || record.length > 0) {
        record.push(field);
        records.push(record);
    }
    const rows = records.filter((r) => r.some((cell) => cell.trim() !== ''));
    const [header = [], ...rest] = rows;
    return { header: header.map((name) => name.trim()), rows: rest };
}

/** Le rang de la première colonne nommée comme l'un de `names`, sans égard à la casse ; -1 sinon. */
export function columnIndex(header: readonly string[], names: readonly string[]): number {
    const wanted = names.map((name) => name.toLowerCase());
    for (const name of wanted) {
        const at = header.findIndex((h) => h.trim().toLowerCase() === name);
        if (at !== -1) return at;
    }
    return -1;
}

/** La cellule d'une ligne, vide quand la colonne manque. */
export function cell(row: readonly string[], index: number): string {
    return index < 0 ? '' : (row[index] ?? '').trim();
}

const ABSENT = /^(|na|n\/a|-|null)$/i;

/** Un entier compté : « 1234 », « 1,234 », « 1 234 » ; `null` pour une cellule vide ou « NA ». */
export function parseCount(raw: string): number | null {
    const text = raw.trim().replace(/[\s\u00a0\u202f]/g, '');
    if (ABSENT.test(text)) return null;
    const plain = /^[+-]?\d{1,3}(,\d{3})+$/.test(text) ? text.replace(/,/g, '') : text;
    if (!/^[+-]?\d+(\.0+)?$/.test(plain)) return null;
    return Math.trunc(Number(plain));
}

/**
 * Un décimal : « 4.32 », « 1,234.50 » ; une virgule seule est décimale
 * (« 4,32 »), sauf à séparer des milliers (« 1,234 »). `null` sinon.
 */
export function parseDecimal(raw: string): number | null {
    let text = raw.trim().replace(/[\s\u00a0\u202f]/g, '');
    if (ABSENT.test(text)) return null;
    if (/^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(text)) text = text.replace(/,/g, '');
    else if (/^[+-]?\d+,\d+$/.test(text)) text = text.replace(',', '.');
    if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(text)) return null;
    const value = Number(text);
    return Number.isFinite(value) ? value : null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Le jour d'une date : `2026-11-14`, `20261114`, `11/14/2026` (Apple) ou `Nov 14, 2026`. */
export function parseDay(raw: string): number | null {
    const text = raw.trim();
    let match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text) ?? /^(\d{4})(\d{2})(\d{2})$/.exec(text);
    if (match) return dayOfDate(Number(match[1]), Number(match[2]), Number(match[3]));
    match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
    if (match) return dayOfDate(Number(match[3]), Number(match[1]), Number(match[2]));
    match = /^([A-Za-z]{3})[a-z]*\.? (\d{1,2}), (\d{4})$/.exec(text);
    if (match) return dayOfDate(Number(match[3]), MONTHS.indexOf(match[1].toLowerCase()) + 1, Number(match[2]));
    return null;
}
