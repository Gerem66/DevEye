import type { ExposureComponent } from '../../contracts/exposure';
import type { FormatId } from '../../contracts/formats';
import { exactVersion, TOOLS, toolOf } from './tools';

/**
 * Ce que les sources qui ne sont pas des dépôts apprennent à la veille : un
 * conteneur par son image, une base par la version de son serveur, un
 * appareil par son système et son moteur. Fonctions pures.
 */

/**
 * Le nom et l'étiquette d'une référence d'image : `docker.io/library/nginx:1.25.3@sha256:…`
 * donne `nginx` et `1.25.3`. Sans étiquette, Docker prend `latest`, qui ne se compare à rien.
 */
export function parseImageRef(ref: string): { name: string; tag: string | null } {
    const bare = ref.trim().split('@')[0];
    const slash = bare.lastIndexOf('/');
    const colon = bare.lastIndexOf(':');
    const hasTag = colon > slash;
    const path = hasTag ? bare.slice(0, colon) : bare;
    return { name: path.slice(path.lastIndexOf('/') + 1).toLowerCase(), tag: hasTag ? bare.slice(colon + 1) : null };
}

/** Le produit qu'une image fait tourner, à sa version exacte, ou rien. */
export function imageComponent(ref: string, format: FormatId, where: string | null): ExposureComponent | null {
    const { name, tag } = parseImageRef(ref);
    const tool = toolOf(name);
    if (!tool || !tag) return null;
    const version = exactVersion(tool, tag);
    if (!version) return null;
    return { kind: 'product', ecosystem: tool, name: TOOLS[tool].label, version, format, path: where, line: null };
}

/**
 * Le serveur d'une base, d'après ce qu'il a répondu à `SELECT VERSION()` :
 * `8.0.36`, `10.11.6-MariaDB-0ubuntu0.24.04.1`, `PostgreSQL 16.2 on x86_64…`.
 */
export function databaseComponent(engine: 'mysql' | 'postgres', serverVersion: string): ExposureComponent | null {
    const raw = serverVersion.trim();
    const tool = engine === 'postgres' ? 'postgres' : /mariadb/i.test(raw) ? 'mariadb' : 'mysql';
    const found = engine === 'postgres' ? /PostgreSQL\s+(\d+(?:\.\d+)+)/i.exec(raw) : /^(\d+\.\d+\.\d+)/.exec(raw);
    const version = found ? exactVersion(tool, found[1]) : null;
    if (!version) return null;
    return {
        kind: 'product',
        ecosystem: tool,
        name: TOOLS[tool].label,
        version,
        format: 'database-server',
        path: null,
        line: null
    };
}

/** Ce qu'un appareil dit de lui et de ses conteneurs, tel que l'agent le rapporte. */
export interface DeviceFacts {
    os: { name: string; version: string } | null;
    engines: readonly { engine: 'docker' | 'podman'; version: string | null }[];
    containers: readonly {
        name: string;
        image: string;
        composeProject: string | null;
        composeService: string | null;
    }[];
}

/**
 * L'inventaire d'un appareil. Le système n'est là que pour sa fin de vie : ses
 * failles passent par ses paquets, que le NVD ne nomme pas assez finement.
 */
export function deviceComponents(facts: DeviceFacts): ExposureComponent[] {
    const out: ExposureComponent[] = [];
    if (facts.os && facts.os.name.trim()) {
        out.push({
            kind: 'product',
            ecosystem: 'os',
            name: facts.os.name.trim(),
            version: facts.os.version.trim(),
            format: 'device-os',
            path: null,
            line: null
        });
    }
    for (const e of facts.engines) {
        const version = e.version ? exactVersion(e.engine, e.version) : null;
        if (!version) continue;
        out.push({
            kind: 'product',
            ecosystem: e.engine,
            name: TOOLS[e.engine].label,
            version,
            format: 'container-engine',
            path: null,
            line: null
        });
    }
    const seen = new Set<string>();
    for (const c of facts.containers) {
        const where =
            c.composeProject && c.composeService ? `${c.name} (${c.composeProject}/${c.composeService})` : c.name;
        const component = imageComponent(c.image, 'container-image', where);
        if (!component) continue;
        const key = `${component.ecosystem}|${component.version}|${where}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(component);
    }
    return out;
}
