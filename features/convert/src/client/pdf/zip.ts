import { zipSync } from 'fflate';

/** Des fichiers déjà compressés (PDF, images) dans une archive, sans les recompresser. */
export function zipFiles(entries: readonly { name: string; bytes: Uint8Array }[]): Uint8Array<ArrayBuffer> {
    const tree: Record<string, Uint8Array> = {};
    const seen = new Map<string, number>();
    for (const entry of entries) {
        // Deux noms identiques (deux fichiers « page.pdf ») restent deux entrées.
        const times = seen.get(entry.name) ?? 0;
        seen.set(entry.name, times + 1);
        const name = times === 0 ? entry.name : entry.name.replace(/(\.[^.]+)?$/, ` (${times + 1})$1`);
        tree[name] = entry.bytes;
    }
    return zipSync(tree, { level: 0 });
}
