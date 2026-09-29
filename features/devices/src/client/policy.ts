import type { AgentPolicy } from '@deveye/types';

/**
 * Les interrupteurs de `[policy]` dans `agent.toml` : ce qu'une machine permet
 * à DevEye, décidé sur elle et que le serveur ne change jamais.
 */
export type PolicyKey = keyof AgentPolicy;

/** Ce que chaque interrupteur couvre, en quelques mots. */
export const POLICY_LABEL: Record<PolicyKey, string> = {
    terminal: 'terminal',
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

/** Le nom de chaque interrupteur pour `--deny`, celui de `PolicyKey` dans l'agent (`config.rs`). */
export const POLICY_FLAG: Record<PolicyKey, string> = {
    terminal: 'terminal',
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
