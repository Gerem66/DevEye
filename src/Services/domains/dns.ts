import { Resolver } from 'node:dns/promises';

import type { SdkDns } from '@deveye/types/sdk/server';

const TIMEOUT_MS = 5_000;

/** Un nom qui n'existe pas (encore) n'est pas une panne : la réponse est vide. */
async function orEmpty<T>(lookup: Promise<T[]>): Promise<T[]> {
    try {
        return await lookup;
    } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === 'ENOTFOUND' || code === 'ENODATA') return [];
        throw error;
    }
}

function resolver(): Resolver {
    return new Resolver({ timeout: TIMEOUT_MS, tries: 2 });
}

export const systemDns: SdkDns = {
    // `resolveTxt` rend un tableau DE TABLEAUX : le protocole découpe une chaîne
    // longue en morceaux de 255 octets, et sans le recollage un enregistrement
    // un peu long (une clé DKIM) ne correspondrait jamais.
    txt: async (name) => (await orEmpty(resolver().resolveTxt(name))).map((pieces) => pieces.join('')),
    mx: (name) => orEmpty(resolver().resolveMx(name)),
    cname: (name) => orEmpty(resolver().resolveCname(name))
};

/** Les adresses d'un nom, les deux familles réunies. Vide s'il n'en a aucune. */
export async function resolveAddresses(name: string): Promise<string[]> {
    const lookups = await Promise.allSettled([orEmpty(resolver().resolve4(name)), orEmpty(resolver().resolve6(name))]);
    return lookups.flatMap((lookup) => (lookup.status === 'fulfilled' ? lookup.value : []));
}
