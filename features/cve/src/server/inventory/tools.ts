import type { FormatId } from '../../contracts/formats';

/**
 * Les outils d'un dépôt : les images Docker qu'il construit ou lance, la
 * version de Node, de Python, de Ruby ou de Rust qu'il épingle. Ce ne sont pas
 * des paquets d'un registre, OSV ne les connaît pas ; le catalogue du NVD, lui,
 * les connaît par leur nom (`f5:nginx`, `nodejs:node.js`).
 *
 * Seule une version exacte se compare : `nginx:1.25` suit les correctifs de la
 * branche, on ne sait pas lequel tourne. Une étiquette flottante est ignorée.
 */

export interface CveProduct {
    vendor: string;
    product: string;
}

interface ToolSpec {
    /** Le nom que l'écran montre. */
    label: string;
    products: CveProduct[];
    /** Combien de nombres fait une version exacte : PostgreSQL en compte deux (`16.1`). */
    segments: number;
}

export const TOOLS: Record<string, ToolSpec> = {
    node: { label: 'Node.js', products: [{ vendor: 'nodejs', product: 'node.js' }], segments: 3 },
    nginx: {
        label: 'nginx',
        products: [
            { vendor: 'f5', product: 'nginx' },
            { vendor: 'nginx', product: 'nginx' }
        ],
        segments: 3
    },
    httpd: { label: 'Apache HTTP Server', products: [{ vendor: 'apache', product: 'http_server' }], segments: 3 },
    tomcat: { label: 'Apache Tomcat', products: [{ vendor: 'apache', product: 'tomcat' }], segments: 3 },
    mysql: { label: 'MySQL', products: [{ vendor: 'oracle', product: 'mysql' }], segments: 3 },
    mariadb: { label: 'MariaDB', products: [{ vendor: 'mariadb', product: 'mariadb' }], segments: 3 },
    postgres: { label: 'PostgreSQL', products: [{ vendor: 'postgresql', product: 'postgresql' }], segments: 2 },
    redis: { label: 'Redis', products: [{ vendor: 'redis', product: 'redis' }], segments: 3 },
    mongo: { label: 'MongoDB', products: [{ vendor: 'mongodb', product: 'mongodb' }], segments: 3 },
    memcached: { label: 'Memcached', products: [{ vendor: 'memcached', product: 'memcached' }], segments: 3 },
    elasticsearch: {
        label: 'Elasticsearch',
        products: [{ vendor: 'elastic', product: 'elasticsearch' }],
        segments: 3
    },
    python: { label: 'Python', products: [{ vendor: 'python', product: 'python' }], segments: 3 },
    ruby: { label: 'Ruby', products: [{ vendor: 'ruby-lang', product: 'ruby' }], segments: 3 },
    php: { label: 'PHP', products: [{ vendor: 'php', product: 'php' }], segments: 3 },
    golang: { label: 'Go', products: [{ vendor: 'golang', product: 'go' }], segments: 3 },
    rust: { label: 'Rust', products: [{ vendor: 'rust-lang', product: 'rust' }], segments: 3 },
    traefik: { label: 'Traefik', products: [{ vendor: 'traefik', product: 'traefik' }], segments: 3 },
    haproxy: { label: 'HAProxy', products: [{ vendor: 'haproxy', product: 'haproxy' }], segments: 3 },
    caddy: { label: 'Caddy', products: [{ vendor: 'caddyserver', product: 'caddy' }], segments: 3 },
    grafana: { label: 'Grafana', products: [{ vendor: 'grafana', product: 'grafana' }], segments: 3 },
    jenkins: { label: 'Jenkins', products: [{ vendor: 'jenkins', product: 'jenkins' }], segments: 3 },
    gitea: { label: 'Gitea', products: [{ vendor: 'gitea', product: 'gitea' }], segments: 3 },
    wordpress: { label: 'WordPress', products: [{ vendor: 'wordpress', product: 'wordpress' }], segments: 3 },
    keycloak: { label: 'Keycloak', products: [{ vendor: 'redhat', product: 'keycloak' }], segments: 3 }
};

/** Les autres noms d'un même outil : celui de son image, de `.tool-versions`, de son projet. */
const ALIASES: Record<string, string> = {
    nodejs: 'node',
    postgresql: 'postgres',
    mongodb: 'mongo',
    go: 'golang',
    apache: 'httpd',
    apache2: 'httpd'
};

/** Les produits dont le catalogue garde tout l'historique, pour qu'une version ancienne trouve ses CVE. */
export const WATCHED_PRODUCTS: readonly CveProduct[] = Object.values(TOOLS).flatMap((t) => t.products);

/** Un outil trouvé dans un fichier, à sa version exacte. */
export interface ToolUse {
    tool: string;
    version: string;
    format: FormatId;
    path: string;
    line: number;
}

export function toolOf(name: string): string | null {
    const base = name.toLowerCase().split('/').pop() ?? '';
    const tool = ALIASES[base] ?? base;
    return tool in TOOLS ? tool : null;
}

/** La version exacte d'une étiquette (`20.11.1-alpine` → `20.11.1`), ou rien pour une étiquette flottante. */
export function exactVersion(tool: string, tag: string): string | null {
    const m = /^v?(\d+(?:\.\d+)*)/.exec(tag);
    if (!m) return null;
    return m[1].split('.').length >= TOOLS[tool].segments ? m[1] : null;
}

const isDockerfile = (p: string): boolean => /(^|\/)(?:Dockerfile(?:\.[^/]+)?|[^/]+\.dockerfile)$/.test(p);
const isCompose = (p: string): boolean => /(^|\/)(?:docker-)?compose(?:\.[\w-]+)?\.ya?ml$/.test(p);
const VERSION_FILES: Record<string, { tool: string; format: FormatId }> = {
    '.nvmrc': { tool: 'node', format: '.nvmrc' },
    '.node-version': { tool: 'node', format: '.node-version' },
    '.python-version': { tool: 'python', format: '.python-version' },
    '.ruby-version': { tool: 'ruby', format: '.ruby-version' }
};

/** Ce chemin peut-il déclarer un outil ? */
export function isToolFile(path: string): boolean {
    const base = path.slice(path.lastIndexOf('/') + 1);
    return (
        isDockerfile(path) ||
        isCompose(path) ||
        base in VERSION_FILES ||
        base === '.tool-versions' ||
        base === 'rust-toolchain' ||
        base === 'rust-toolchain.toml' ||
        base === 'package.json'
    );
}

/** Le numéro de ligne (1-indexé) de la position `index` dans `text`. */
function lineAt(text: string, index: number): number {
    let line = 1;
    for (let i = 0; i < index && i < text.length; i++) {
        if (text.charCodeAt(i) === 10) line++;
    }
    return line;
}

/** Les outils qu'un fichier déclare, à leur version exacte. Fonction pure. */
export function findTools(path: string, text: string): ToolUse[] {
    const base = path.slice(path.lastIndexOf('/') + 1);
    const out: ToolUse[] = [];
    const push = (tool: string | null, tag: string, index: number, format: FormatId): void => {
        if (!tool) return;
        const version = exactVersion(tool, tag);
        if (!version) return;
        out.push({ tool, version, format, path, line: lineAt(text, index) });
    };

    if (isDockerfile(path)) {
        const from = /^\s*FROM\s+(?:--platform=\S+\s+)?([\w./-]+):([\w.-]+)/gim;
        for (let m = from.exec(text); m !== null; m = from.exec(text)) {
            push(toolOf(m[1]), m[2], m.index, 'Dockerfile');
        }
    }
    if (isCompose(path)) {
        const image = /^\s*image:\s*["']?([\w./-]+):([\w.-]+)/gm;
        for (let m = image.exec(text); m !== null; m = image.exec(text)) {
            push(toolOf(m[1]), m[2], m.index, 'compose');
        }
    }
    const pinned = VERSION_FILES[base];
    if (pinned) push(pinned.tool, text.trim(), 0, pinned.format);
    if (base === '.tool-versions') {
        const entry = /^\s*([\w-]+)\s+([\w.-]+)/gm;
        for (let m = entry.exec(text); m !== null; m = entry.exec(text)) {
            push(toolOf(m[1]), m[2], m.index, '.tool-versions');
        }
    }
    if (base === 'rust-toolchain' || base === 'rust-toolchain.toml') {
        const channel = /^\s*(?:channel\s*=\s*")?(\d+\.\d+\.\d+)/m.exec(text);
        if (channel) push('rust', channel[1], channel.index, 'rust-toolchain');
    }
    if (base === 'package.json') {
        const engines = /"engines"\s*:\s*\{[^}]*"node"\s*:\s*"v?(\d+\.\d+\.\d+)"/.exec(text);
        if (engines) push('node', engines[1], engines.index, 'engines');
    }
    return out;
}
