import type { ComponentNotes, ExposureComponent } from '../../contracts/exposure';
import { eolProductOf, indexOf, releaseFor, type EolIndex, type EolProduct } from '../matching/eol';
import { metaKey, REGISTRY_SYSTEM, type PackageMeta } from '../matching/registry';
import type { CveRepo } from '../repo';

let cached: { at: number; index: EolIndex } | null = null;

/**
 * Le catalogue des fins de vie, relu de la base seulement quand un tour l'a
 * remplacé : quelques mégaoctets de JSON ne se reparsent pas à chaque requête.
 */
export async function loadEolIndex(repo: Pick<CveRepo, 'getState' | 'listEolProducts'>): Promise<EolIndex | null> {
    const fetchedAt = await repo.getState('eolFetchedAt');
    if (fetchedAt === null) return null;
    if (cached?.at !== fetchedAt) {
        const products = (await repo.listEolProducts()).flatMap((r) => {
            try {
                return [JSON.parse(r.body) as EolProduct];
            } catch {
                return [];
            }
        });
        cached = { at: fetchedAt, index: indexOf(products) };
    }
    return cached.index;
}

/** Ce que les catalogues disent de chaque composant : sa fin de vie, sa dernière version, sa dépréciation. */
export async function annotate(
    repo: CveRepo,
    components: readonly ExposureComponent[]
): Promise<(ExposureComponent & { notes: ComponentNotes })[]> {
    const index = await loadEolIndex(repo);
    const systemOf = (c: ExposureComponent): string | undefined =>
        c.kind === 'package' && c.direct ? REGISTRY_SYSTEM[c.ecosystem] : undefined;
    const keys = components.flatMap((c) => {
        const system = systemOf(c);
        return system ? [metaKey(system, c.name)] : [];
    });
    // Quel que soit son âge : l'inventaire montre ce qui est su, la veille le rafraîchit.
    const metas = new Map(
        (await repo.pkgMeta([...new Set(keys)], 0)).map((r) => [r.pkg_key, JSON.parse(r.body) as PackageMeta | null])
    );
    const now = Date.now();
    return components.map((c) => {
        const product = index ? eolProductOf(c, index) : null;
        const release = product ? releaseFor(product, c.version) : null;
        const at = release?.eolFrom ? Date.parse(`${release.eolFrom}T00:00:00Z`) : NaN;
        const system = systemOf(c);
        const meta = system ? metas.get(metaKey(system, c.name)) : undefined;
        return {
            ...c,
            notes: {
                eol: release
                    ? {
                          release: release.name,
                          date: release.eolFrom,
                          reached: release.isEol || (Number.isFinite(at) && at <= now)
                      }
                    : null,
                latest: meta?.latest ?? null,
                deprecated: meta ? meta.deprecated[c.version] !== undefined : false
            }
        };
    });
}
