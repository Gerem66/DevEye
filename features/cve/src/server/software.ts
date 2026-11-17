import { defineSdkFeature, FeatureError, type SdkFeatureContext } from '@deveye/types/sdk/server';

import { cveSoftware, cveSoftwareSearch, SOFTWARE_MATCHES_MAX, type Software } from '../contracts/software';
import { loadEolIndex } from './exposure/annotate';
import { exactVersion, TOOLS } from './inventory/tools';
import { eolProductOfTool, type EolIndex, type EolProduct } from './matching/eol';
import { nvdStaleReason } from './matching/nvdCatalogue';
import { branchesFor, searchSoftware } from './matching/software';
import { isAffected } from './versions';
import type { CveRepo } from './repo';

type Ctx = SdkFeatureContext<CveRepo>;

export function toSoftware(product: EolProduct, fetchedAt: number): Software {
    return {
        name: product.name,
        label: product.label,
        category: product.category,
        link: product.link,
        hasEoas: product.hasEoas,
        hasEoes: product.hasEoes,
        releases: product.releases,
        fetchedAt
    };
}

/** Le catalogue des fins de vie et la date de son chargement, ou une erreur qui dit qu'il n'est pas encore là. */
export async function eolCatalogue(ctx: Ctx) {
    const [index, fetchedAt] = await Promise.all([loadEolIndex(ctx.repo), ctx.repo.getState('eolFetchedAt')]);
    return index && fetchedAt !== null ? { index, fetchedAt } : null;
}

/** L'outil de la veille qu'un logiciel d'endoflife.date désigne (`nodejs` → `node`). */
function toolOfSoftware(index: EolIndex, product: EolProduct): string | null {
    return Object.keys(TOOLS).find((tool) => eolProductOfTool(tool, index) === product) ?? null;
}

export interface VersionScope {
    product: string;
    version: string;
    exact: boolean;
    stale: string | null;
    cveIds: string[];
}

/**
 * Une requête qui nomme un outil que la veille suit et une version : les CVE
 * du catalogue local qui touchent cette version exacte, confrontées comme la
 * veille le fait. `null` pour toute autre requête, qui reste une recherche par
 * mots.
 */
export async function versionScope(ctx: Ctx, query: string): Promise<VersionScope | null> {
    const catalogue = await eolCatalogue(ctx);
    if (!catalogue) return null;
    const { products, version } = searchSoftware(catalogue.index, query);
    if (version === null || products.length === 0) return null;
    const tool = toolOfSoftware(catalogue.index, products[0]);
    if (!tool) return null;
    const spec = TOOLS[tool];
    const exact = exactVersion(tool, version);
    if (exact === null) return { product: spec.label, version, exact: false, stale: null, cveIds: [] };
    const ids = new Set<string>();
    for (const p of spec.products) {
        for (const row of await ctx.repo.affecting(p.vendor, p.product)) {
            if (isAffected(exact, row)) ids.add(row.cve_id);
        }
    }
    const stale = await nvdStaleReason(ctx.repo, spec.products, Math.floor(Date.now() / 1000));
    return { product: spec.label, version: exact, exact: true, stale, cveIds: [...ids] };
}

export const softwareHandlers = [
    defineSdkFeature({
        ...cveSoftware,
        handler: async (ctx: Ctx, input) => {
            const catalogue = await eolCatalogue(ctx);
            if (!catalogue) throw new FeatureError('not_found', 'Le catalogue des fins de vie se charge encore.');
            const product = catalogue.index.byName.get(input.name);
            if (!product) throw new FeatureError('not_found', `${input.name} est inconnu d’endoflife.date.`);
            return { software: toSoftware(product, catalogue.fetchedAt) };
        }
    }),
    defineSdkFeature({
        ...cveSoftwareSearch,
        handler: async (ctx: Ctx, input) => {
            // Un catalogue pas encore chargé ne trouve rien : la recherche des
            // CVE, à côté, répond quand même.
            const catalogue = await eolCatalogue(ctx);
            if (!catalogue) return { matches: [], version: null, more: 0 };
            const { products, version } = searchSoftware(catalogue.index, input.query);
            return {
                matches: products.slice(0, SOFTWARE_MATCHES_MAX).map((p) => ({
                    software: toSoftware(p, catalogue.fetchedAt),
                    releases: version === null ? [] : branchesFor(p, version)
                })),
                version,
                more: Math.max(0, products.length - SOFTWARE_MATCHES_MAX)
            };
        }
    })
];
