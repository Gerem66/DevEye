/**
 * Les mots encodés d'un en-tête (RFC 2047) rendus en texte : `=?UTF-8?Q?Caf=C3=A9?=`
 * devient « Café ». Pour la recherche seulement : sur le fil, un en-tête part tel qu'il est entré.
 */

const WORD = /=\?([^?*]+)(?:\*[^?]*)?\?([bBqQ])\?([^?]*)\?=/g;

function decodeBytes(bytes: Buffer, charset: string): string {
    try {
        return new TextDecoder(charset.toLowerCase()).decode(bytes);
    } catch {
        return bytes.toString('latin1');
    }
}

/** `header` est une chaîne d'octets : ce qui n'est pas encodé est relu comme de l'UTF-8 brut. */
export function decodeHeaderText(header: string): string {
    const plain = Buffer.from(header, 'latin1').toString('utf8');
    return (
        plain
            // Deux mots encodés ne sont séparés que par du blanc à ignorer.
            .replace(/(\?=)\s+(=\?)/g, '$1$2')
            .replace(WORD, (_, charset: string, encoding: string, text: string) => {
                const bytes =
                    encoding.toLowerCase() === 'b'
                        ? Buffer.from(text, 'base64')
                        : Buffer.from(
                              text
                                  .replace(/_/g, ' ')
                                  .replace(/=([0-9A-Fa-f]{2})/g, (__, hex: string) =>
                                      String.fromCharCode(parseInt(hex, 16))
                                  ),
                              'latin1'
                          );
                return decodeBytes(bytes, charset);
            })
    );
}
