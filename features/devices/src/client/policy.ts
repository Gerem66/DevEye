import type { AgentInfo, AgentPolicy, Device } from '@deveye/types';

/**
 * Les interrupteurs de `[policy]` dans `agent.toml` : ce qu'une machine permet
 * à DevEye, décidé sur elle et que le serveur ne change jamais.
 */
export type PolicyKey = keyof AgentPolicy;

/** Ce que chaque interrupteur couvre, en quelques mots. */
export const POLICY_LABEL: Record<PolicyKey, string> = {
    terminal: 'terminal',
    terminalRoot: 'terminal root',
    filesRead: 'lecture de fichiers',
    filesWrite: 'écriture de fichiers',
    power: 'commandes système',
    pkgUpgrade: 'mises à jour système',
    serviceElevate: 'élévation en root',
    destroy: 'auto-destruction',
    docker: 'conteneurs Docker',
    dockerDeploy: 'déploiements',
    sync: 'partages CloudSync',
    tunnel: 'accès au réseau'
};

/** Dans l'ordre où l'agent les liste. */
export const POLICY_KEYS = Object.keys(POLICY_LABEL) as PolicyKey[];

/** Le nom de chaque interrupteur pour `--allow`, celui de `PolicyKey` dans l'agent (`config.rs`). */
export const POLICY_FLAG: Record<PolicyKey, string> = {
    terminal: 'terminal',
    terminalRoot: 'terminal-root',
    filesRead: 'files-read',
    filesWrite: 'files-write',
    power: 'power',
    pkgUpgrade: 'pkg-upgrade',
    serviceElevate: 'service-elevate',
    destroy: 'destroy',
    docker: 'docker',
    dockerDeploy: 'docker-deploy',
    sync: 'sync',
    tunnel: 'tunnel'
};

/** Un interrupteur qui n'ouvre rien sans un autre : l'agent exige les deux. */
export const POLICY_REQUIRES: Partial<Record<PolicyKey, PolicyKey>> = {
    terminalRoot: 'terminal',
    dockerDeploy: 'docker'
};

/** Les interrupteurs choisis, sans ceux dont le préalable manque, dans l'ordre de l'agent. */
export function effectivePolicy(chosen: readonly PolicyKey[]): PolicyKey[] {
    return POLICY_KEYS.filter((key) => {
        const needs = POLICY_REQUIRES[key];
        return chosen.includes(key) && (needs === undefined || chosen.includes(needs));
    });
}

/**
 * Ce qui retient le terminal d'un agent lancé en administrateur quand la
 * machine ne permet pas le terminal root : `account`, le shell serait root
 * faute d'un autre compte nommé dans les réglages du terminal ; `policy`, sous
 * Windows, où le shell est toujours celui de l'agent ; `null`, rien.
 */
export function rootTerminalBlock(
    device: Pick<Device, 'platform' | 'terminalDefaultUser'>,
    agent: AgentInfo | null | undefined
): 'account' | 'policy' | null {
    if (!agent?.privileged || agent.policy.terminalRoot) return null;
    if (device.platform === 'windows') return 'policy';
    const user = device.terminalDefaultUser;
    return user && user !== agent.user ? null : 'account';
}
