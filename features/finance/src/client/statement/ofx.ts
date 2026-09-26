import { STATEMENT_LABEL_MAX_LENGTH, type StatementLineInput } from '../../contracts/statement';
import { parseMoney, type ParsedStatement } from './csv';

/**
 * Le relevé d'une banque en OFX (ou QFX, le même), lu dans le navigateur. Deux
 * générations : la première en SGML, où une balise feuille ne se ferme pas, la
 * seconde en XML. Les champs se lisent donc jusqu'à la balise suivante, jamais
 * jusqu'à leur balise fermante. La banque donne à chaque ligne son identité
 * (`FITID`) : c'est elle qui fait d'un second import un non-événement.
 */

export function looksLikeOfx(text: string): boolean {
    return /<OFX>/i.test(text) || /^\s*OFXHEADER/i.test(text);
}

function field(block: string, name: string): string {
    const match = new RegExp(`<${name}>\\s*([^<\\r\\n]*)`, 'i').exec(block);
    return match === null ? '' : decodeEntities(match[1].trim());
}

function decodeEntities(value: string): string {
    return value
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&apos;/gi, "'")
        .replace(/&amp;/gi, '&');
}

/** `20260915120000[+1:CET]` : seul le jour compte, l'heure et le fuseau déplaceraient une ligne d'un jour. */
function ofxDay(value: string): string | null {
    const match = /^(\d{4})(\d{2})(\d{2})/.exec(value);
    if (match === null) return null;
    const [, year, month, day] = match;
    const at = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    if (at.getUTCMonth() !== Number(month) - 1) return null;
    return `${year}-${month}-${day}`;
}

export function parseOfx(text: string): ParsedStatement {
    const lines: StatementLineInput[] = [];
    let skipped = 0;
    const blocks = text.split(/<STMTTRN>/i).slice(1);
    for (const raw of blocks) {
        const block = raw.split(/<\/STMTTRN>|<\/BANKTRANLIST>/i)[0];
        const date = ofxDay(field(block, 'DTPOSTED'));
        const signed = parseMoney(field(block, 'TRNAMT'));
        if (date === null || signed === null || signed === 0) {
            skipped += 1;
            continue;
        }
        const name = field(block, 'NAME');
        const memo = field(block, 'MEMO');
        const fitid = field(block, 'FITID');
        lines.push({
            date,
            direction: signed < 0 ? 'out' : 'in',
            amount: Math.abs(signed),
            label: (name || memo).slice(0, STATEMENT_LABEL_MAX_LENGTH),
            memo: name ? memo.slice(0, STATEMENT_LABEL_MAX_LENGTH) : '',
            fitid: fitid === '' ? null : fitid.slice(0, 80)
        });
    }

    let closing: ParsedStatement['closing'] = null;
    const ledger = /<LEDGERBAL>([\s\S]*?)(?:<\/LEDGERBAL>|<AVAILBAL>|<\/STMTRS>|$)/i.exec(text);
    if (ledger !== null) {
        const balance = parseMoney(field(ledger[1], 'BALAMT'));
        const date = ofxDay(field(ledger[1], 'DTASOF'));
        if (balance !== null && date !== null) closing = { balance, date };
    }
    return { lines, skipped, closing };
}
