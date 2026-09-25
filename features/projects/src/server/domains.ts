import type { FeatureDomainsEntry } from '@deveye/types/sdk/server';

// Le garde des appels sortants, partagé par toute l'app : le nom sondé est
// choisi par un membre, et il ne doit mener ni au réseau privé ni en boucle.
import { safeFetch } from '@/Services/netFetch';

import type { ProjectsRepo } from './repo';

/**
 * La moitié « service » de la vérification d'un domaine. Le socle a déjà vu le
 * nom pointer ici et répondre en HTTPS (`manifest.domains.web`) : reste à savoir
 * que c'est bien cette installation qui répond, par le jeton que la route
 * publique rend sous ce nom.
 */

export const WELL_KNOWN_PATH = '/.well-known/deveye-projects';

/** Le jeton tient en 32 caractères : au-delà, ce n'est pas la réponse attendue. */
const PROOF_MAX_BYTES = 4_096;

export interface DomainSeam {
    fetchProof?(url: string): Promise<string>;
}

/** `fetch` enveloppe la vraie cause d'un échec réseau : c'est elle qu'on dit. */
function reason(error: unknown): string {
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message.length > 0) return cause.message;
    return error instanceof Error ? error.message : String(error);
}

async function fetchProof(url: string): Promise<string> {
    const res = await safeFetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(8_000),
        headers: { accept: 'text/plain', 'user-agent': 'DevEye-Projects/1.0' }
    });
    if (!res.ok) throw new Error(`Le domaine répond (code ${res.status}), mais pas comme DevEye l’attend.`);
    const reader = res.body?.getReader();
    if (!reader) return '';
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > PROOF_MAX_BYTES) {
            await reader.cancel();
            throw new Error('Le domaine répond, mais ce n’est pas cette installation.');
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
}

export function createDomainHooks(seam: DomainSeam = {}): FeatureDomainsEntry<ProjectsRepo> {
    const proofOf = seam.fetchProof ?? fetchProof;

    return {
        records: (ctx, domain) =>
            Promise.resolve([{ type: 'CNAME', name: domain.host, value: new URL(ctx.origins.public).host }]),

        async probe(_ctx, domain) {
            try {
                const body = await proofOf(`https://${domain.host}${WELL_KNOWN_PATH}`);
                return body.trim() === domain.token
                    ? { ok: true }
                    : { ok: false, error: 'Le domaine répond, mais ce n’est pas cette installation.' };
            } catch (error) {
                return { ok: false, error: reason(error) };
            }
        },

        useCount: (ctx, workspaceId) => ctx.repo.publication.domainUse(workspaceId),

        // Les projets qu'il servait reviennent à l'adresse de DevEye, où leur lien répond toujours.
        onRemoved: (ctx, domain) => ctx.repo.publication.clearDomain(domain.id, domain.workspaceId)
    };
}
