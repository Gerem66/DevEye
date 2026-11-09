import { existsSync, readFileSync } from 'node:fs';
import path from 'path';
import type { Plugin } from 'vite';
import { CLIENT_DIR } from '../paths';

/** Un SVG prêt à être cité entre guillemets doubles dans un `url()`. */
function dataUri(svg: string): string {
    const encoded = svg
        .trim()
        .replace(/\s+/g, ' ')
        .replace(/> </g, '><')
        // Le `%` d'abord : sinon il échapperait les échappements suivants.
        .replace(/%/g, '%25')
        .replace(/#/g, '%23')
        .replace(/</g, '%3C')
        .replace(/>/g, '%3E')
        .replace(/"/g, "'");
    return `data:image/svg+xml,${encoded}`;
}

/**
 * Les icônes en dur dans les feuilles, jamais en requête.
 *
 * Une icône est un `mask-image: url(/icons/<nom>.svg)` : le navigateur ne va la
 * chercher qu'au premier rendu d'un élément qui la porte. Celles de la pastille
 * « Connexion perdue » seraient donc à charger exactement quand le serveur ne
 * répond plus. Les inliner en `data:` (une quarantaine de kilo-octets pour les
 * quatre-vingts) ferme la question : aucune requête, aucune latence au premier
 * affichage. `icons.css` et ses jumeaux générés restent la source de vérité.
 *
 * `enforce: 'pre'` est obligatoire : passé le plugin CSS de Vite, ces URL sont
 * déjà devenues ses propres marqueurs d'actif public.
 */
export function inlineIcons(): Plugin {
    const iconsDir = path.join(CLIENT_DIR, 'public', 'icons');
    // Les feuilles où une icône a été inlinée : ce sont elles qu'il faut
    // retransformer quand un SVG change, lui-même hors du graphe de modules.
    const sheets = new Set<string>();

    return {
        name: 'deveye:inline-icons',
        enforce: 'pre',
        transform(code, id) {
            const file = id.split('?')[0];
            if (!file.endsWith('.css') || !code.includes('/icons/')) return null;
            let inlined = false;
            const out = code.replace(/url\(\s*["']?\/icons\/([^"')\s]+\.svg)["']?\s*\)/g, (_match, name: string) => {
                const source = path.join(iconsDir, name);
                // Un SVG absent ne se voit pas : la classe rend un carré vide,
                // sans erreur. Autant refuser la feuille.
                if (!existsSync(source)) this.error(`${path.basename(file)} : /icons/${name} est introuvable`);
                inlined = true;
                return `url("${dataUri(readFileSync(source, 'utf-8'))}")`;
            });
            if (!inlined) return null;
            sheets.add(file);
            return { code: out, map: null };
        },
        handleHotUpdate({ file, server, modules }) {
            if (!file.startsWith(iconsDir + path.sep)) return;
            const affected = [...modules];
            sheets.forEach((sheet) => {
                server.moduleGraph.getModulesByFile(sheet)?.forEach((mod) => {
                    server.moduleGraph.invalidateModule(mod);
                    affected.push(mod);
                });
            });
            return affected;
        }
    };
}
