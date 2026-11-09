import { POLICY_FLAG, POLICY_KEYS, type PolicyKey } from '../policy';

/**
 * Les commandes que la fenêtre d'appairage fait copier : installer l'agent et
 * relier la machine d'une ligne (`install.sh`, `install.ps1`), ou relier un
 * agent déjà présent. Les droits choisis deviennent des options de `link` :
 * c'est la machine qui les retient, jamais le serveur.
 */

export type InstallOs = 'linux' | 'macos' | 'windows';

export interface InstallChoice {
    os: InstallOs;
    /** L'origine que l'agent joint, sans barre finale. */
    server: string;
    code: string;
    /** Ce que la machine refusera ; vide : contrôle complet. */
    denied: readonly PolicyKey[];
    autostart: boolean;
    /** Linux et macOS : sous `sudo`, pour un service système. */
    admin: boolean;
    /** Une identité tirée au hasard, pour les copies d'une même image. */
    shuffleId: boolean;
    /**
     * L'instance nommée de l'agent qui porte cet enrôlement, pour une machine
     * suivie par plusieurs serveurs DevEye ; absente : l'enrôlement par défaut.
     */
    instance?: string | null;
}

/** `--instance <nom>`, que l'agent accepte avant comme après sa commande. */
function instanceArgs(choice: InstallChoice): string[] {
    return choice.instance ? ['--instance', choice.instance] : [];
}

/** Les options de `deveye-agent link`, que le script lui passe telles quelles. */
export function linkArgs(choice: InstallChoice): string[] {
    const args: string[] = [];
    const denied = POLICY_KEYS.filter((key) => choice.denied.includes(key));
    if (denied.length === POLICY_KEYS.length) args.push('--monitor-only');
    else if (denied.length > 0) args.push('--deny', denied.map((key) => POLICY_FLAG[key]).join(','));
    if (choice.autostart) args.push('--autostart');
    if (choice.shuffleId) args.push('--shuffle-id');
    return args;
}

/** Les versions de Windows PowerShell d'avant TLS 1.2 par défaut refuseraient le serveur. */
const PS_TLS12 = '[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072';

/** Installe l'agent qui convient à la machine, puis la relie. */
export function installCommand(choice: InstallChoice): string {
    const args = [choice.code, ...instanceArgs(choice), ...linkArgs(choice)];
    if (choice.os === 'windows') {
        const script = psArg(`${choice.server}/install.ps1`);
        return `${PS_TLS12}; & ([scriptblock]::Create((irm ${script}))) ${args.map(psArg).join(' ')}`;
    }
    const shell = choice.admin ? 'sudo sh' : 'sh';
    return `curl -fsSL ${shArg(`${choice.server}/install.sh`)} | ${shell} -s -- ${args.map(shArg).join(' ')}`;
}

/** Relie une machine où l'agent est déjà installé. */
export function linkCommand(choice: InstallChoice): string {
    const args = [...instanceArgs(choice), 'link', choice.code, '--server', choice.server, ...linkArgs(choice)];
    if (choice.os === 'windows') return `deveye-agent.exe ${args.map(psArg).join(' ')}`;
    // `-H` : la config est celle de root, où le service système la cherche.
    return `${choice.admin ? 'sudo -H ' : ''}deveye-agent ${args.map(shArg).join(' ')}`;
}

/** Le contrat de `instance::parse` dans l'agent : le nom finit dans des noms de fichier, d'unité et de tâche. */
const INSTANCE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const INSTANCE_NAME_MAX = 32;
/** Ce que `status` appelle l'enrôlement sans nom : aucune instance ne le prend. */
const DEFAULT_INSTANCE_LABEL = 'default';

/** Un nom d'instance que l'agent acceptera. */
export function isInstanceName(name: string): boolean {
    return INSTANCE_NAME.test(name) && name !== DEFAULT_INSTANCE_LABEL;
}

/**
 * Un nom d'instance tiré du libellé de l'instance distante (« NAS maison » :
 * `nas-maison`), sinon de l'hôte de son adresse, sinon `distant`.
 */
export function suggestInstanceName(label: string, origin: string): string {
    const host = (() => {
        try {
            return new URL(origin).hostname;
        } catch {
            return '';
        }
    })();
    for (const source of [label, host]) {
        const slug = slugify(source);
        if (isInstanceName(slug)) return slug;
    }
    return 'distant';
}

function slugify(text: string): string {
    return text
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, INSTANCE_NAME_MAX)
        .replace(/-+$/, '');
}

/** Un mot que le shell lit tel quel, sinon entre apostrophes. */
export function shArg(value: string): string {
    return /^[A-Za-z0-9_\-.,:/=+@]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Idem pour PowerShell, où la virgule fait un tableau et `@` une décomposition. */
export function psArg(value: string): string {
    return /^[A-Za-z0-9_\-.:/=+]+$/.test(value) ? value : `'${value.replaceAll("'", "''")}'`;
}

/** Le système de la machine qui affiche la page : le plus probable de celle à relier. */
export function osOf(platform: string): InstallOs {
    // macOS d'abord : « Darwin » contient « win ».
    if (/mac|darwin|iphone|ipad/i.test(platform)) return 'macos';
    if (/win/i.test(platform)) return 'windows';
    return 'linux';
}
