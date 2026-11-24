/**
 * Les imports que seul un bundler sait lire, rendus à Node : une feuille de
 * style en module donne ses noms de classe tels quels (`styles.title` vaut
 * `'title'`), toute autre feuille ou image ne donne rien d'utile à un test.
 */

const STYLE = /\.(css|scss)$/;
const ASSET = /\.(svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|mp3|mp4|webm)$/;

const CLASS_NAMES = `export default new Proxy({}, { get: (_, name) => (typeof name === 'string' ? name : undefined) });`;
const WORKER = `export default class { postMessage() {} terminate() {} addEventListener() {} removeEventListener() {} }`;

/** Le suffixe de Vite (`?url`, `?worker`, `?raw`) ne désigne pas un autre fichier. */
function splitQuery(specifier) {
    const at = specifier.indexOf('?');
    return at === -1 ? [specifier, ''] : [specifier.slice(0, at), specifier.slice(at + 1)];
}

export async function resolve(specifier, context, nextResolve) {
    const [path, query] = splitQuery(specifier);
    if (query === '' && !STYLE.test(path) && !ASSET.test(path)) return nextResolve(specifier, context);
    const resolved = await nextResolve(path, context);
    return { ...resolved, url: query === '' ? resolved.url : `${resolved.url}?${query}`, shortCircuit: true };
}

export async function load(url, context, nextLoad) {
    const [path, query] = splitQuery(url);
    const source =
        query === 'worker'
            ? WORKER
            : query === 'raw'
              ? `export default '';`
              : /\.module\.(css|scss)$/.test(path)
                ? CLASS_NAMES
                : STYLE.test(path)
                  ? ''
                  : ASSET.test(path) || query === 'url'
                    ? `export default ${JSON.stringify(new URL(path).pathname)};`
                    : null;
    if (source === null) return nextLoad(url, context);
    return { format: 'module', source, shortCircuit: true };
}
