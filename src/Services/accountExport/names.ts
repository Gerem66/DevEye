/** Ce que Windows refuse comme nom, extension comprise : `CON`, `nul.txt`… */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
/** Ce qu'un système de fichiers refuse dans un nom, ou qui changerait le chemin. */
const FORBIDDEN = /[\u0000-\u001f\u007f\\/:*?"<>|]/g;
/** Un segment reste loin des 255 octets d'un nom sous Linux, accents compris. */
const MAX_SEGMENT = 120;

/** Un segment de chemin sûr partout : caractères interdits remplacés, points et espaces de fin ôtés. */
export function safeSegment(raw: string): string {
    let name = raw
        .normalize('NFC')
        .replace(FORBIDDEN, '_')
        .trim()
        .replace(/[. ]+$/, '');
    if (name === '' || name === '.' || name === '..') name = '_';
    if (RESERVED.test(name)) name = `_${name}`;
    if (name.length > MAX_SEGMENT) {
        const dot = name.lastIndexOf('.');
        const ext = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : '';
        name = name.slice(0, MAX_SEGMENT - ext.length) + ext;
    }
    return name;
}

/** Un chemin relatif sûr, segment par segment ; rien ne remonte au-dessus de la racine. */
export function safePath(raw: string): string {
    return raw
        .split(/[\\/]+/)
        .filter((segment) => segment !== '')
        .map(safeSegment)
        .join('/');
}

/**
 * Les noms déjà pris dans l'archive : un second « Notes » devient
 * « Notes (2) », sans égard à la casse, que Windows et macOS ignorent.
 */
export class NameBook {
    private readonly taken = new Set<string>();

    take(path: string): string {
        const safe = safePath(path);
        if (!this.taken.has(safe.toLowerCase())) {
            this.taken.add(safe.toLowerCase());
            return safe;
        }
        const slash = safe.lastIndexOf('/');
        const dir = safe.slice(0, slash + 1);
        const base = safe.slice(slash + 1);
        const dot = base.lastIndexOf('.');
        const [stem, ext] = dot > 0 ? [base.slice(0, dot), base.slice(dot)] : [base, ''];
        for (let n = 2; ; n++) {
            const candidate = `${dir}${stem} (${n})${ext}`;
            if (!this.taken.has(candidate.toLowerCase())) {
                this.taken.add(candidate.toLowerCase());
                return candidate;
            }
        }
    }
}
