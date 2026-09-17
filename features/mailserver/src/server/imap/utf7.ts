/**
 * L'UTF-7 modifié des noms de dossiers (RFC 3501 §5.1.3) : tout ce qui n'est
 * pas de l'ASCII imprimable voyage en base64 d'UTF-16, entre `&` et `-`, avec
 * `,` à la place de `/`. Un `&` littéral s'écrit `&-`.
 */

export function encodeUtf7(name: string): string {
    let out = '';
    let run = '';
    const flush = (): void => {
        if (run === '') return;
        const utf16 = Buffer.from(run, 'utf16le').swap16();
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

export function decodeUtf7(text: string): string {
    return text.replace(/&([^-]*)-/g, (_, chunk: string) => {
        if (chunk === '') return '&';
        const bytes = Buffer.from(chunk.replace(/,/g, '/'), 'base64');
        // Un nombre impair d'octets ne fait pas de l'UTF-16 : le dernier est ignoré.
        return bytes
            .subarray(0, bytes.length - (bytes.length % 2))
            .swap16()
            .toString('utf16le');
    });
}
