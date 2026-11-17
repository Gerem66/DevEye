import { defineSdkFeature, FeatureError, type SdkFeatureContext } from '@deveye/types/sdk/server';

import { cveSoftware, cveSoftwareSearch, SOFTWARE_MATCHES_MAX, type Software } from '../contracts/software';
import { loadEolIndex } from './exposure/annotate';
import type { EolProduct } from './matching/eol';
import { branchesFor, searchSoftware } from './matching/software';
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
