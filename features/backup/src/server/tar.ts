/**
 * Un écrivain `tar` USTAR minimal (fichiers et dossiers), pour qu'une archive
 * se rouvre avec le `tar` de n'importe quel système. Deux écarts, tous deux
 * des extensions GNU lues par GNU tar et bsdtar : les chemins que `prefix`
 * (155) + `name` (100) ne tiennent pas passent par une entrée `L`
 * (`@LongLink`), et une taille d'au moins 8 Gio s'écrit en base 256.
 */

const BLOCK = 512;
const NUL = Buffer.alloc(BLOCK);

/** Type d'entrée USTAR. */
const TYPE_FILE = '0';
const TYPE_DIR = '5';
/** Nom long, extension GNU. */
const TYPE_LONGNAME = 'L';

export interface TarEntry {
    /** Chemin dans l'archive, séparateurs `/`, sans `./` ni `..`. */
    path: string;
    size: number;
    /** Millisecondes unix. */
    mtime: number;
    /** Permissions Unix ; `null` → 0644 pour un fichier, 0755 pour un dossier. */
    mode: number | null;
    isDir: boolean;
}

function octal(value: number, length: number): string {
    // `length - 1` chiffres puis un NUL : la forme que tous les lecteurs
    // acceptent, alors que l'espace final ne l'est pas partout.
    return (
        value
            .toString(8)
            .padStart(length - 1, '0')
            .slice(-(length - 1)) + '\0'
    );
}

/** Ce que tiennent les 11 chiffres octaux du champ de taille : 8 Gio moins un octet. */
const OCTAL_SIZE_MAX = 0o77777777777;

/** Au-delà, l'octal perdrait ses premiers chiffres : la base 256 marque son premier octet de 0x80. */
function writeSize(buf: Buffer, size: number): void {
    if (size <= OCTAL_SIZE_MAX) {
        buf.write(octal(size, 12), 124, 12, 'ascii');
        return;
    }
    buf[124] = 0x80;
    let rest = size;
    for (let i = 135; i > 124; i -= 1) {
        buf[i] = rest % 256;
        rest = Math.floor(rest / 256);
    }
}

/** L'en-tête d'une entrée, somme de contrôle comprise. */
function header(name: string, prefix: string, size: number, mtime: number, mode: number, type: string): Buffer {
    const buf = Buffer.alloc(BLOCK);
    buf.write(name.slice(0, 100), 0, 100, 'utf8');
    buf.write(octal(mode & 0o7777, 8), 100, 8, 'ascii');
    buf.write(octal(0, 8), 108, 8, 'ascii'); // uid
    buf.write(octal(0, 8), 116, 8, 'ascii'); // gid
    writeSize(buf, size);
    buf.write(octal(Math.floor(mtime / 1000), 12), 136, 12, 'ascii');
    // La somme se calcule en considérant son propre champ comme huit espaces.
    buf.write('        ', 148, 8, 'ascii');
    buf.write(type, 156, 1, 'ascii');
    buf.write('ustar\0', 257, 6, 'ascii');
    buf.write('00', 263, 2, 'ascii');
    buf.write(prefix.slice(0, 155), 345, 155, 'utf8');

    let sum = 0;
    for (const byte of buf) sum += byte;
    buf.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    return buf;
}

/** Le bourrage qui ramène `size` à un multiple de 512. */
function padding(size: number): Buffer {
    const rest = size % BLOCK;
    return rest === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - rest);
}

/** Découpe en (prefix, name) USTAR, ou `null` si impossible : l'appelant émet alors un `@LongLink`. */
function split(path: string): { name: string; prefix: string } | null {
    const bytes = Buffer.byteLength(path, 'utf8');
    if (bytes <= 100) return { name: path, prefix: '' };
    if (bytes > 255) return null;
    // On cherche la coupure la plus tardive qui laisse un `name` tenable.
    for (let i = path.length - 1; i > 0; i -= 1) {
        if (path[i] !== '/') continue;
        const prefix = path.slice(0, i);
        const name = path.slice(i + 1);
        if (Buffer.byteLength(name, 'utf8') <= 100 && Buffer.byteLength(prefix, 'utf8') <= 155) {
            return { name, prefix };
        }
    }
    return null;
}

/** Les blocs d'en-tête d'une entrée (avec son `@LongLink` s'il en faut un). */
export function tarHeader(entry: TarEntry): Buffer {
    const path = entry.isDir && !entry.path.endsWith('/') ? `${entry.path}/` : entry.path;
    const mode = entry.mode ?? (entry.isDir ? 0o755 : 0o644);
    const type = entry.isDir ? TYPE_DIR : TYPE_FILE;
    const size = entry.isDir ? 0 : entry.size;

    const parts = split(path);
    if (parts) return header(parts.name, parts.prefix, size, entry.mtime, mode, type);

    const nameBytes = Buffer.from(`${path}\0`, 'utf8');
    return Buffer.concat([
        header('././@LongLink', '', nameBytes.length, 0, 0, TYPE_LONGNAME),
        nameBytes,
        padding(nameBytes.length),
        // Le `name` tronqué reste renseigné : un lecteur qui ignore `@LongLink`
        // extrait alors un chemin coupé plutôt que rien du tout.
        header(path.slice(0, 100), '', size, entry.mtime, mode, type)
    ]);
}

/** Le bourrage de fin de contenu d'une entrée. */
export function tarPadding(size: number): Buffer {
    return padding(size);
}

/** Les deux blocs nuls qui terminent une archive. */
export function tarEnd(): Buffer {
    return Buffer.concat([NUL, NUL]);
}
