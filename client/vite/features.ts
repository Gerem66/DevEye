import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'path';
import { APP_DIR, WORKSPACE_DIR } from './paths';

/** Les paquets des modules installés, d'après `features.config.json`. */
export function installedFeaturePackages(): string[] {
    const configPath = path.join(APP_DIR, 'features.config.json');
    if (!existsSync(configPath)) return [];
    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as { features?: { package: string }[] };
    return (config.features ?? []).map((f) => f.package);
}

/**
 * En dev, chaque module installé dont le checkout frère existe à la racine du
 * chantier se résout vers sa source, pour la même raison que `@deveye/types`
 * (typesSource.ts). Un module in-repo (`features/*`) est déjà de la source.
 */
export function siblingFeatureAliases(): Record<string, string> {
    const aliases: Record<string, string> = {};
    for (const pkg of installedFeaturePackages()) {
        const src = path.join(WORKSPACE_DIR, pkg, 'src');
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
export function featureChunkRoots(): [string, string][] {
    const roots: [string, string][] = [];
    const add = (dir: string, pkg: string) => {
        const slug = /^deveye-feature-([a-z0-9]+)$/.exec(pkg)?.[1];
        if (!slug || !existsSync(dir)) return;
        roots.push([realpathSync(dir) + path.sep, slug]);
    };
    for (const pkg of installedFeaturePackages()) {
        add(path.join(APP_DIR, 'node_modules', pkg), pkg);
    }
    const localConfig = path.join(APP_DIR, 'features.local.json');
    if (existsSync(localConfig)) {
        const local = JSON.parse(readFileSync(localConfig, 'utf-8')) as {
            features?: { package: string; path: string }[];
        };
        for (const f of local.features ?? []) add(path.resolve(APP_DIR, f.path), f.package);
    }
    return roots;
}
