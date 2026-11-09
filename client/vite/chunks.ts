import type { Rollup } from 'vite';

/**
 * Atteint par un import statique depuis une entrée ? Sinon, seuls des `import()`
 * y mènent : le module est chargé à la demande et doit garder un chunk à lui.
 * Rangé dans celui de sa feature ou dans `vendor`, il serait préchargé avec eux
 * dès la première peinture (l'éditeur du Tableau blanc, le terminal des
 * appareils).
 */
function staticReach(): (id: string, getModuleInfo: Rollup.GetModuleInfo) => boolean {
    const known = new Map<string, boolean>();
    return (id, getModuleInfo) => {
        const cached = known.get(id);
        if (cached !== undefined) return cached;
        const seen = new Set<string>([id]);
        const stack = [id];
        let reached = false;
        while (stack.length > 0 && !reached) {
            const current = stack.pop() as string;
            const verdict = known.get(current);
            if (verdict === true) reached = true;
            if (verdict !== undefined) continue;
            const info = getModuleInfo(current);
            if (info === null) continue;
            if (info.isEntry) {
                reached = true;
                break;
            }
            for (const importer of info.importers) {
                if (!seen.has(importer)) {
                    seen.add(importer);
                    stack.push(importer);
                }
            }
        }
        // Sans entrée au-dessus, aucun des modules visités n'en a : tous le sont à la demande.
        if (reached) known.set(id, true);
        else for (const visited of seen) known.set(visited, false);
        return reached;
    };
}

/**
 * Le découpage du build. Chaque module de feature a son chunk : son code ne pèse
 * pas sur la première peinture et se met en cache seul. Les bibliothèques tierces
 * vont dans des chunks vendeurs, gardés en cache d'un déploiement à l'autre.
 * `featureRoots` : le vrai chemin de chaque module installé et son slug.
 */
export function manualChunks(featureRoots: [string, string][]): Rollup.GetManualChunk {
    const reachable = staticReach();
    return (id, { getModuleInfo }) => {
        if (!reachable(id, getModuleInfo)) return undefined;
        // Deux formes de chemin selon la provenance : package installé, ou
        // workspace `features/*` résolu à son vrai chemin.
        const feature = id.match(/deveye-feature-([a-z0-9]+)/) ?? /[/\\]features[/\\]([a-z0-9]+)[/\\]src[/\\]/.exec(id);
        if (feature) return `feature-${feature[1]}`;
        // Troisième forme : un module installé par symlink ou par l'overlay
        // local, dont le realpath ne porte aucun des deux motifs. Son
        // `node_modules` interne (devDeps de son typecheck) n'est pas son code :
        // ce qui en reste après dédoublonnage va aux chunks vendeurs.
        const byRoot = id.includes('node_modules') ? undefined : featureRoots.find(([root]) => id.startsWith(root));
        if (byRoot) return `feature-${byRoot[1]}`;
        if (!id.includes('node_modules')) return undefined;
        if (id.includes('framer-motion')) return 'framer-motion';
        if (id.includes('/react') || id.includes('/scheduler')) return 'react-vendor';
        return 'vendor';
    };
}
