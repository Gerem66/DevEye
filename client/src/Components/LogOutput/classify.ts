/**
 * Lecture d'un journal brut (sortie de build, d'un conteneur) : les séquences
 * ANSI retirées, les retours chariot résolus, et chaque ligne rangée par ce
 * qu'elle dit (étape, erreur, avertissement, succès, bruit) avec ses jetons
 * (horodatage, durée, identifiant d'étape). Pur : testé sans navigateur.
 */

export type LogLineKind = 'step' | 'error' | 'warning' | 'success' | 'muted' | 'plain';
export type LogTokenKind = 'text' | 'time' | 'duration' | 'id';

export interface LogToken {
    kind: LogTokenKind;
    text: string;
}

export interface LogLineView {
    text: string;
    kind: LogLineKind;
    tokens: LogToken[];
}

/** Les séquences d'échappement ANSI (couleurs, curseur) d'une sortie de terminal. */
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export function stripAnsi(text: string): string {
    return text.replace(ANSI, '');
}

/**
 * Les lignes d'un texte : `\r\n` vaut `\n`, et un `\r` seul garde ce qui le
 * suit (une barre de progression réécrit sa ligne, c'est le dernier état qui
 * compte).
 */
export function splitLines(text: string): string[] {
    return text.split('\n').map((raw) => {
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
        const cr = line.lastIndexOf('\r');
        return cr === -1 ? line : line.slice(cr + 1);
    });
}

/** Un horodatage en tête de ligne : ISO, `[12:00:03]` ou `12:00:03`. */
const LEADING_TIME =
    /^(?:\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d)?|\[\d\d:\d\d:\d\d(?:\.\d+)?\]|\d\d:\d\d:\d\d(?:\.\d+)?)/;
/** L'identifiant d'une étape BuildKit (`#12 [stage 3/7] RUN …`). */
const LEADING_ID = /^(\s*)(#\d+)(?= |$)/;
const DURATION = /\b\d+(?:\.\d+)?(?:ms|s)\b/g;

const MUTED = [/^##\[endgroup\]/, /^##\[debug\]/, /^\s*$/];
const STEP = [/^=== .+ ===$/, /^##\[group\]/, /^#\d+ \[/, /^Step \d+\/\d+/];
const ERROR = [/^##\[error\]/, /\b(?:error|fail(?:ed|ure)?|fatal|panic)/i, /\bERR!/, /exit code [1-9]/i, /[✖✗]/];
const WARNING = [/^##\[warning\]/, /\b(?:warn|deprecat)/i];
const SUCCESS = [/^#\d+ (?:DONE|CACHED)\b/, /\b(?:done|success(?:ful|fully)?|succeeded|completed|finished)\b/i, /[✓✔]/];

const matchesAny = (text: string, rules: readonly RegExp[]): boolean => rules.some((rule) => rule.test(text));

function kindOf(body: string): LogLineKind {
    if (matchesAny(body, MUTED)) return 'muted';
    if (matchesAny(body, STEP)) return 'step';
    if (matchesAny(body, ERROR)) return 'error';
    if (matchesAny(body, WARNING)) return 'warning';
    if (matchesAny(body, SUCCESS)) return 'success';
    return 'plain';
}

function tokenize(line: string): { tokens: LogToken[]; body: string } {
    const tokens: LogToken[] = [];
    let rest = line;
    const time = LEADING_TIME.exec(rest);
    if (time) {
        tokens.push({ kind: 'time', text: time[0] });
        rest = rest.slice(time[0].length);
    }
    const body = rest.trimStart();
    const id = LEADING_ID.exec(rest);
    if (id) {
        if (id[1]) tokens.push({ kind: 'text', text: id[1] });
        tokens.push({ kind: 'id', text: id[2] });
        rest = rest.slice(id[0].length);
    }
    let last = 0;
    for (const match of rest.matchAll(DURATION)) {
        const at = match.index;
        if (at > last) tokens.push({ kind: 'text', text: rest.slice(last, at) });
        tokens.push({ kind: 'duration', text: match[0] });
        last = at + match[0].length;
    }
    if (last < rest.length) tokens.push({ kind: 'text', text: rest.slice(last) });
    return { tokens, body };
}

export function classifyLine(text: string): LogLineView {
    const { tokens, body } = tokenize(text);
    return { text, kind: kindOf(body), tokens };
}

/** Le journal entier, nettoyé et rangé ; la ligne vide d'un `\n` final ne compte pas. */
export function classifyLog(text: string): LogLineView[] {
    const lines = splitLines(stripAnsi(text));
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines.map(classifyLine);
}
