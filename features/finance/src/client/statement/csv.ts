import { STATEMENT_LABEL_MAX_LENGTH, type StatementClosing, type StatementLineInput } from '../../contracts/statement';

/**
 * Le relevé d'une banque en CSV, lu dans le navigateur. Aucun format commun :
 * le séparateur, l'encodage, l'en-tête, le sens du montant changent d'une banque
 * à l'autre. D'où une table lue telle quelle, une correspondance des colonnes
 * devinée puis retenue par compte, et des lignes normalisées au bout.
 */

export interface CsvTable {
    separator: string;
    /** Les intitulés de colonnes, `null` quand le fichier n'en a pas. */
    header: string[] | null;
    rows: string[][];
}

/** Quelle colonne dit quoi. Des index dans la table. */
export interface CsvMapping {
    date: number;
    /** Les colonnes qui forment le libellé, jointes par une espace. */
    label: number[];
    /** Un montant signé ; sinon débit et crédit, dans deux colonnes. */
    amount: number | null;
    debit: number | null;
    credit: number | null;
    balance: number | null;
    /** Le jour avant le mois quand l'année vient en dernier : 15/09/2026. */
    dayFirst: boolean;
}

export interface ParsedStatement {
    lines: StatementLineInput[];
    /** Les lignes lues mais écartées : sans date, sans montant, ou un total. */
    skipped: number;
    closing: StatementClosing | null;
}

const SEPARATORS = [';', ',', '\t', '|'];

/** UTF-8 si le fichier en est, sinon Windows-1252, que produisent encore beaucoup de banques. */
export function decodeStatement(bytes: Uint8Array): string {
    let text: string;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        text = new TextDecoder('windows-1252').decode(bytes);
    }
    return text.replace(/^\uFEFF/, '');
}

/** Découpe le texte en lignes et en cellules, guillemets compris : `"a;b"` reste une cellule, `""` vaut un guillemet. */
function records(text: string, separator: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quoted) {
            if (c === '"' && text[i + 1] === '"') {
                cell += '"';
                i += 1;
            } else if (c === '"') quoted = false;
            else cell += c;
        } else if (c === '"' && cell.trim() === '') {
            quoted = true;
            cell = '';
        } else if (c === separator) {
            row.push(cell);
            cell = '';
        } else if (c === '\n' || c === '\r') {
            if (c === '\r' && text[i + 1] === '\n') i += 1;
            row.push(cell);
            rows.push(row);
            row = [];
            cell = '';
        } else cell += c;
    }
    if (cell !== '' || row.length > 0) {
        row.push(cell);
        rows.push(row);
    }
    return rows.map((r) => r.map((value) => value.trim())).filter((r) => r.some((value) => value !== ''));
}

/** Le séparateur qui découpe le plus régulièrement les premières lignes en plus d'une colonne. */
function detectSeparator(text: string): string {
    const sample = text
        .split(/\r?\n/)
        .filter((line) => line.trim() !== '')
        .slice(0, 30)
        .join('\n');
    let best = { separator: ';', score: 0 };
    for (const separator of SEPARATORS) {
        const counts = records(sample, separator).map((r) => r.length);
        const frequent = new Map<number, number>();
        for (const n of counts) if (n > 1) frequent.set(n, (frequent.get(n) ?? 0) + 1);
        for (const [columns, times] of frequent) {
            const score = times * columns;
            if (score > best.score) best = { separator, score };
        }
    }
    return best.separator;
}

/**
 * Un montant écrit à la main par une banque, en centimes signés, ou `null`.
 * « 1 234,56 », « -12,30 », « 12.30 », « (12,30) », « 12,30- », « 12,30 € ».
 */
export function parseMoney(text: string): number | null {
    let value = text.replace(/[\s\u00a0\u202f]/g, '').replace(/[€$£]|EUR|USD|GBP|CHF/gi, '');
    if (value === '') return null;
    let negative = false;
    if (/^\(.*\)$/.test(value)) {
        negative = true;
        value = value.slice(1, -1);
    }
    if (value.endsWith('-')) {
        negative = !negative;
        value = value.slice(0, -1);
    }
    if (value.startsWith('-')) {
        negative = !negative;
        value = value.slice(1);
    } else if (value.startsWith('+')) value = value.slice(1);

    const lastComma = value.lastIndexOf(',');
    const lastDot = value.lastIndexOf('.');
    if (lastComma !== -1 && lastDot !== -1) {
        const decimal = lastComma > lastDot ? ',' : '.';
        const thousands = decimal === ',' ? '.' : ',';
        value = value.split(thousands).join('').replace(decimal, '.');
    } else if (lastComma !== -1) {
        // Deux chiffres au plus derrière : des centimes. Trois : un séparateur de milliers.
        value = /,\d{1,2}$/.test(value)
            ? `${value.slice(0, lastComma).replace(/,/g, '')}.${value.slice(lastComma + 1)}`
            : value.replace(/,/g, '');
    } else if (lastDot !== -1 && !/\.\d{1,2}$/.test(value)) {
        value = value.replace(/\./g, '');
    }
    if (!/^\d+(\.\d+)?$/.test(value)) return null;
    const cents = Math.round(Number(value) * 100);
    return negative ? -cents : cents;
}

function isoDay(year: number, month: number, day: number): string | null {
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const at = new Date(Date.UTC(year, month - 1, day));
    if (at.getUTCMonth() !== month - 1) return null;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Un jour civil écrit par une banque, en `AAAA-MM-JJ`, ou `null`. */
export function parseDay(text: string, dayFirst = true): string | null {
    const value = text.trim();
    let match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(value);
    if (match) return isoDay(Number(match[1]), Number(match[2]), Number(match[3]));
    match = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
    if (match) return isoDay(Number(match[1]), Number(match[2]), Number(match[3]));
    match = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})(?:\D|$)/.exec(value);
    if (!match) return null;
    const year = match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
    const first = Number(match[1]);
    const second = Number(match[2]);
    return dayFirst ? isoDay(year, second, first) : isoDay(year, first, second);
}

/** La table du fichier, l'en-tête reconnu et les lignes parasites qui le précèdent écartées. `null` si rien ne se lit. */
export function parseCsvTable(text: string): CsvTable | null {
    const separator = detectSeparator(text);
    const all = records(text, separator);
    // La première ligne de données : une date quelque part, et un montant ailleurs.
    const first = all.findIndex(
        (row) =>
            row.some((cell) => parseDay(cell) !== null) &&
            row.some((cell) => parseDay(cell) === null && parseMoney(cell) !== null)
    );
    if (first === -1) return null;
    const previous = first > 0 ? all[first - 1] : null;
    const header =
        previous !== null &&
        previous.filter((cell) => cell !== '').length >= 2 &&
        !previous.some((cell) => parseDay(cell))
            ? previous
            : null;
    return { separator, header, rows: all.slice(first) };
}

/** Le nombre de colonnes d'une table : la ligne la plus large. */
export function columnCount(table: CsvTable): number {
    return Math.max(table.header?.length ?? 0, ...table.rows.map((row) => row.length));
}

/** Le nom d'une colonne pour un sélecteur : son intitulé, sinon son rang. */
export function columnName(table: CsvTable, index: number): string {
    const name = table.header?.[index]?.trim();
    return name ? name : `Colonne ${index + 1}`;
}

function share(table: CsvTable, index: number, test: (cell: string) => boolean): number {
    const cells = table.rows.map((row) => row[index] ?? '').filter((cell) => cell !== '');
    if (cells.length === 0) return 0;
    return cells.filter(test).length / table.rows.length;
}

/** Une correspondance devinée : par les intitulés quand il y en a, par le contenu sinon. */
export function guessMapping(table: CsvTable): CsvMapping {
    const count = columnCount(table);
    const names = Array.from({ length: count }, (_, i) => (table.header?.[i] ?? '').toLowerCase());
    const find = (pattern: RegExp, except: RegExp | null = null) =>
        names.findIndex((name) => pattern.test(name) && (except === null || !except.test(name)));

    const dates = Array.from({ length: count }, (_, i) => i).filter(
        (i) => share(table, i, (c) => parseDay(c) !== null) > 0.6
    );
    let date = find(/date/, /valeur|value/);
    if (date === -1) date = find(/date/);
    if (date === -1) date = dates[0] ?? 0;

    const money = Array.from({ length: count }, (_, i) => i).filter(
        (i) => !dates.includes(i) && i !== date && share(table, i, (c) => parseMoney(c) !== null) > 0.3
    );
    let debit: number | null = find(/d[ée]bit/);
    let credit: number | null = find(/cr[ée]dit/);
    let amount: number | null = find(/montant|amount|somme/);
    let balance: number | null = find(/solde|balance/);
    if (debit === -1) debit = null;
    if (credit === -1) credit = null;
    if (amount === -1) amount = null;
    if (balance === -1) balance = null;
    if (amount === null && (debit === null || credit === null)) {
        const candidates = money.filter((i) => i !== balance);
        // Deux colonnes qui ne se remplissent jamais ensemble : un débit et un crédit.
        if (candidates.length >= 2) {
            [debit, credit] = [candidates[0], candidates[1]];
        } else if (candidates.length === 1) {
            amount = candidates[0];
        }
    }
    if (amount !== null) {
        debit = null;
        credit = null;
    }

    const taken = new Set([date, amount, debit, credit, balance].filter((i): i is number => i !== null));
    let label = names
        .map((name, i) => ({ name, i }))
        .filter(
            ({ name, i }) =>
                !taken.has(i) &&
                /libell|intitul|descri|op[ée]ration|d[ée]tail|motif|objet|label|payee|b[ée]n[ée]ficiaire|nature/.test(
                    name
                )
        )
        .map(({ i }) => i);
    if (label.length === 0) {
        // La colonne au texte le plus long, hors dates et montants.
        const lengths = Array.from({ length: count }, (_, i) => i)
            .filter((i) => !taken.has(i) && !dates.includes(i) && !money.includes(i))
            .map((i) => ({ i, length: table.rows.reduce((sum, row) => sum + (row[i]?.length ?? 0), 0) }))
            .sort((a, b) => b.length - a.length);
        label = lengths.length > 0 ? [lengths[0].i] : [];
    }

    // Une date dont le premier nombre dépasse 12 dit jour d'abord ; le second, mois d'abord.
    let dayFirst = true;
    for (const row of table.rows) {
        const match = /^(\d{1,2})[-/.](\d{1,2})[-/.]/.exec(row[date] ?? '');
        if (!match) continue;
        if (Number(match[2]) > 12) {
            dayFirst = false;
            break;
        }
        if (Number(match[1]) > 12) break;
    }

    return { date, label, amount, debit, credit, balance, dayFirst };
}

/** Les lignes du relevé selon une correspondance, et le solde de la ligne la plus récente. */
export function csvLines(table: CsvTable, mapping: CsvMapping): ParsedStatement {
    const lines: StatementLineInput[] = [];
    const balances: { date: string; balance: number }[] = [];
    let skipped = 0;
    for (const row of table.rows) {
        const date = parseDay(row[mapping.date] ?? '', mapping.dayFirst);
        let signed: number | null = null;
        if (mapping.amount !== null) {
            signed = parseMoney(row[mapping.amount] ?? '');
        } else {
            const out = mapping.debit === null ? null : parseMoney(row[mapping.debit] ?? '');
            const inn = mapping.credit === null ? null : parseMoney(row[mapping.credit] ?? '');
            // Un débit s'écrit positif ou négatif selon la banque : c'est sa colonne qui dit le sens.
            if (out !== null && out !== 0) signed = -Math.abs(out);
            else if (inn !== null && inn !== 0) signed = Math.abs(inn);
        }
        if (date === null || signed === null || signed === 0) {
            skipped += 1;
            continue;
        }
        lines.push({
            date,
            direction: signed < 0 ? 'out' : 'in',
            amount: Math.abs(signed),
            label: mapping.label
                .map((i) => row[i] ?? '')
                .filter((part) => part !== '')
                .join(' ')
                .slice(0, STATEMENT_LABEL_MAX_LENGTH),
            memo: '',
            fitid: null
        });
        if (mapping.balance !== null) {
            const balance = parseMoney(row[mapping.balance] ?? '');
            if (balance !== null) balances.push({ date, balance });
        }
    }

    let closing: StatementClosing | null = null;
    if (balances.length > 0) {
        // Du plus récent au plus ancien ou l'inverse selon la banque : le solde est celui
        // de la ligne la plus récente, la première rencontrée si le fichier descend.
        const descending = lines.length > 1 && lines[0].date > lines[lines.length - 1].date;
        const latest = balances.reduce((a, b) => (b.date > a.date ? b : a)).date;
        const sameDay = balances.filter((entry) => entry.date === latest);
        const pick = descending ? sameDay[0] : sameDay[sameDay.length - 1];
        closing = { balance: pick.balance, date: pick.date };
    }
    return { lines, skipped, closing };
}

/** L'empreinte d'un en-tête, pour reconnaître le même export d'une fois sur l'autre. */
export function headerSignature(table: CsvTable): string {
    return table.header === null ? `colonnes:${columnCount(table)}` : table.header.join('|');
}
