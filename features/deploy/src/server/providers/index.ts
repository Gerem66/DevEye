import type { DeployCredentialProvider } from '../../contracts/domain';

import { DokployProvider } from './dokploy';
import { GithubProvider } from './github';
import { ProviderError, type DeployProviderAdapter } from './types';

export type DeployProviders = Readonly<Record<DeployCredentialProvider, DeployProviderAdapter>>;

/** Les fournisseurs du processus, un par famille d'accès, avec leurs caches. */
export const PROVIDERS: DeployProviders = { dokploy: new DokployProvider(), github: new GithubProvider() };

/** Le fournisseur d'un accès ou d'une cible, tel qu'écrit en base. */
export function providerOf(providers: DeployProviders, raw: string): DeployProviderAdapter {
    if (raw === 'dokploy' || raw === 'github') return providers[raw];
    throw new ProviderError(`Fournisseur de déploiement inconnu : ${raw}.`, 0);
}
