import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig, type Plugin } from 'vite';
import { existsSync, readFileSync, realpathSync } from 'node:fs';

const serverPort = process.env.LISTEN_PORT ?? '3000';
const serverOrigin = `http://localhost:${serverPort}`;

// Single source of truth for the app version: the root package.json. The client
// has no `version` of its own — `__APP_VERSION__` is injected at build time.
const { version: appVersion } = JSON.parse(readFileSync(path.resolve(__dirname, '../package.json'), 'utf-8'));

/**
 * Where the client reads the shared contracts from.
 *
 * `@deveye/types` is a published package, but between releases it's edited in
 * place inside `node_modules` — and Vite serves anything under `node_modules`
 * with a one-year `immutable` cache, under a `?v=` URL that only changes when
 * package.json or the lockfile do. A contract change therefore stayed invisible
 * to an already-loaded browser however many times the dev server restarted,
 * surfacing as "Unknown command" with nothing pointing at the cause.
 *
 * In dev, resolving to the sibling checkout instead makes it ordinary source:
 * watched, hot-reloaded, never over-cached. Builds always take the installed
 * package, so the release path is untouched — and the checkout is optional, the
 * alias simply doesn't apply when it isn't there.
 */
const TYPES_SOURCE_ENTRY = path.resolve(__dirname, '../../DevEye-Types/src/index.ts');
const TYPES_SOURCE_DIR = path.resolve(__dirname, '../../DevEye-Types/src');

/**
 * Les modules de features installés (features.config.json), et pour chacun, en
 * dev, l'éventuel checkout frère à la racine du chantier : même logique que
 * `@deveye/types` ci-dessus, un package publié qui s'édite en place et que le
 * pré-bundling servirait rassis. Un module in-repo (`features/*`, lien de
 * workspace) n'a pas besoin d'alias : c'est déjà de la source ordinaire.
 */
function installedFeaturePackages(): string[] {
    const configPath = path.resolve(__dirname, '../features.config.json');
    if (!existsSync(configPath)) return [];
    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as { features?: { package: string }[] };
    return (config.features ?? []).map((f) => f.package);
}

function siblingFeatureAliases(): Record<string, string> {
    const aliases: Record<string, string> = {};
    for (const pkg of installedFeaturePackages()) {
        const src = path.resolve(__dirname, '../../', pkg, 'src');
        if (!existsSync(path.join(src, 'index.ts'))) continue;
        aliases[`${pkg}/server`] = path.join(src, 'server', 'index.ts');
        aliases[`${pkg}/client`] = path.join(src, 'client', 'index.ts');
        aliases[pkg] = path.join(src, 'index.ts');
    }
    return aliases;
}

/**
 * Le vrai chemin sur disque de chaque module installé, avec son slug.
 *
 * `manualChunks` reçoit des ids résolus au realpath : un package installé par
 * symlink (npm link, overlay `features.local.json` en imports relatifs) n'y
 * montre ni `deveye-feature-<slug>` ni `features/<slug>/src/`, et retombait
 * dans le chunk principal. La carte préfixe → slug rattrape ces deux formes ;
 * les modules du workspace `features/*` gardent leur motif de chemin.
 */
function featureChunkRoots(): [string, string][] {
    const roots: [string, string][] = [];
    const add = (dir: string, pkg: string) => {
        const slug = /^deveye-feature-([a-z0-9]+)$/.exec(pkg)?.[1];
        if (!slug || !existsSync(dir)) return;
        roots.push([realpathSync(dir) + path.sep, slug]);
    };
    for (const pkg of installedFeaturePackages()) {
        add(path.resolve(__dirname, '../node_modules', pkg), pkg);
    }
    const localConfig = path.resolve(__dirname, '../features.local.json');
    if (existsSync(localConfig)) {
        const local = JSON.parse(readFileSync(localConfig, 'utf-8')) as {
            features?: { package: string; path: string }[];
        };
        for (const f of local.features ?? []) add(path.resolve(__dirname, '..', f.path), f.package);
    }
    return roots;
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
function inlineIcons(): Plugin {
    const iconsDir = path.resolve(__dirname, 'public', 'icons');
    // Les feuilles où une icône a été inlinée : ce sont elles qu'il faut
    // retransformer quand un SVG change, lui-même hors du graphe de modules.
    const sheets = new Set<string>();

    /** Un SVG prêt à être cité entre guillemets doubles dans un `url()`. */
    const dataUri = (svg: string): string => {
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
    };

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

// https://vitejs.dev/config/
export default defineConfig(({ command }) => {
    const featureRoots = featureChunkRoots();
    const useTypesSource = command === 'serve' && existsSync(TYPES_SOURCE_ENTRY);

    return {
        define: {
            __APP_VERSION__: JSON.stringify(appVersion)
        },
        plugins: [react(), inlineIcons()],
        optimizeDeps: {
            // `@deveye/types` ships TypeScript source and is the one dependency that
            // changes in step with the app. Vite's dep pre-bundling keys its cache on
            // package.json/lockfile hashes, never on a dependency's file contents, so
            // editing the package in place (which is how it's iterated on before a
            // release) left the browser served a stale bundle — missing exports that
            // exist on disk, with no hint as to why. Excluding it from pre-bundling
            // routes it through the normal transform pipeline, where edits are picked
            // up like any other source file.
            exclude: ['@deveye/types', ...installedFeaturePackages()]
        },
        server: {
            port: 5173,
            fs: {
                // La glue locale des modules privés importe des checkouts
                // frères (../DevEye-CloudSync/...) : le dev-serve doit pouvoir
                // les lire. Sans dossier frère, la permission est inerte.
                allow: [path.resolve(__dirname, '..', '..')]
            },
            open: true,
            // Same-origin dev: proxy API + WebSocket to the Fastify server so the
            // browser only ever talks to localhost:5173 (no CORS, cookies just work).
            proxy: {
                '/api': { target: serverOrigin, changeOrigin: true },
                '/ws': { target: serverOrigin, ws: true, changeOrigin: true },
                // Le script de mesure d'audience vit **hors de `/api`** : c'est
                // l'adresse qu'on colle dans une page, et `/t.js` se retient.
                // Sans cette entrée, Vite le cherche parmi ses propres fichiers
                // et rend un 404 — la balise semble alors cassée alors que le
                // serveur la sert parfaitement sur le port 3000.
                '/t.js': { target: serverOrigin, changeOrigin: true }
            }
        },
        build: {
            outDir: 'build',
            sourcemap: true,
            chunkSizeWarningLimit: 1024,
            rollupOptions: {
                output: {
                    // Split heavy third-party libs into their own long-lived chunks so the
                    // app bundle stays small and vendor code is cached across deploys.
                    manualChunks(id) {
                        // Chaque module de feature dans son propre chunk : son code ne
                        // pèse pas sur la première peinture, et se met en cache seul.
                        // Deux formes de chemin selon la provenance (package installé,
                        // ou workspace `features/*` résolu à son vrai chemin).
                        const feature =
                            id.match(/deveye-feature-([a-z0-9]+)/) ??
                            /[/\\]features[/\\]([a-z0-9]+)[/\\]src[/\\]/.exec(id);
                        if (feature) return `feature-${feature[1]}`;
                        // Troisième forme : un module installé par symlink ou
                        // par l'overlay local, dont le realpath ne porte aucun
                        // des deux motifs ci-dessus.
                        // Le `node_modules` interne d'un module (devDeps de son
                        // typecheck) n'est pas son code : ce qui en resterait
                        // après dédoublonnage va aux chunks vendeurs.
                        const byRoot = id.includes('node_modules')
                            ? undefined
                            : featureRoots.find(([root]) => id.startsWith(root));
                        if (byRoot) return `feature-${byRoot[1]}`;
                        if (!id.includes('node_modules')) return undefined;
                        if (id.includes('framer-motion')) return 'framer-motion';
                        // xterm is only pulled in by the lazily-loaded terminal panel; keep
                        // it in its own chunk so it loads on demand, not on first paint.
                        if (id.includes('@xterm')) return 'xterm';
                        if (id.includes('/react') || id.includes('/scheduler')) return 'react-vendor';
                        return 'vendor';
                    }
                }
            }
        },
        resolve: {
            // Un module privé installé par chemin a son propre `node_modules`
            // (devDeps de son typecheck autonome) : sans dédoublonnage, ses
            // fichiers résolvaient `react` et `zod` vers SES copies, bundlées
            // en double, et deux React dans la même page cassent les hooks.
            // Tout se résout vers les copies de l'app, comme en dev.
            dedupe: ['react', 'react-dom', 'zod', '@deveye/types'],
            alias: {
                '@': path.resolve(__dirname, 'src'),
                // La surface client du SDK des modules : un vrai module de l'app,
                // servi sous son nom de contrat (voir src/sdk/index.ts).
                'deveye-sdk-client': path.resolve(__dirname, 'src/sdk/index.ts'),
                // Les sous-chemins AVANT le nu : l'alias remplace par préfixe, et
                // `@deveye/types/sdk` ne doit pas devenir `src/index.ts/sdk`.
                ...(useTypesSource
                    ? {
                          '@deveye/types/sdk/server': path.join(TYPES_SOURCE_DIR, 'sdk', 'server.ts'),
                          '@deveye/types/sdk/client': path.join(TYPES_SOURCE_DIR, 'sdk', 'client.ts'),
                          '@deveye/types/sdk/testing': path.join(TYPES_SOURCE_DIR, 'sdk', 'testing.ts'),
                          '@deveye/types/sdk': path.join(TYPES_SOURCE_DIR, 'sdk', 'index.ts'),
                          '@deveye/types': TYPES_SOURCE_ENTRY
                      }
                    : {}),
                ...(command === 'serve' ? siblingFeatureAliases() : {})
            }
        }
    };
});
