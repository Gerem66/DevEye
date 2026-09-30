import type { DeployCandidate, DeployCredentialProvider, DeployStatus, DeployTargetKind } from '../../contracts/domain';
import type { DeviceRelay } from '@deveye/types/sdk/server';

/**
 * Ce qu'un fournisseur de déploiement sait faire pour le module : proposer des
 * cibles, en déclencher une, rendre son historique, son journal et son lieu.
 * Le module ne connaît que ce contrat ; chaque fournisseur y projette son
 * vocabulaire et garde ses propres caches.
 */

/** Ce qu'un accès ouvre, déchiffré le temps d'un appel. */
export interface ProviderAccess {
    /** Clé des caches du fournisseur : un catalogue vaut pour tout son accès. */
    credentialId: number;
    baseUrl: string | null;
    /** L'agent qui joint l'instance à la place du serveur ; `null` quand le serveur la joint lui-même. */
    relay: DeviceRelay | null;
    secret: string;
}

/** Ce qu'une cible désigne chez son fournisseur. */
export interface ProviderTarget {
    kind: DeployTargetKind;
    externalId: string;
    /** La branche d'un workflow ; `null` ailleurs. */
    ref: string | null;
}

/** Un déploiement tel que le fournisseur le décrit, ramené aux quatre états du module. */
export interface RemoteDeployment {
    externalId: string | null;
    status: DeployStatus;
    title: string;
    description: string;
    startedAt: number;
    finishedAt: number | null;
    /** De quoi relire son journal ; opaque hors de son fournisseur. */
    logRef: string | null;
    /** Sa page chez le fournisseur, ou celle de l'instance à défaut. */
    url: string | null;
    /** Des repères propres au fournisseur (workflow, branche), que l'avis reprend. */
    details: readonly { name: string; value: string }[];
}

/** Où vit une cible, tel que l'avis Discord le montre. */
export interface TargetPlace {
    /** Les cases d'identité, dans l'ordre : Discord en place trois par ligne. */
    fields: readonly { name: string; value: string }[];
    /** Sa fiche chez le fournisseur ; `null` si elle ne se reconstruit pas. */
    link: { name: string; label: string; url: string } | null;
}

export interface ReadOptions {
    timeoutMs?: number;
}

/**
 * Un refus du fournisseur, dans ses mots. `retryAt` (secondes) quand il dit
 * lui-même quand revenir : une limite de débit, que le suivi de fond respecte.
 */
export class ProviderError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly retryAt: number | null = null
    ) {
        super(message);
        this.name = 'ProviderError';
    }
}

export interface DeployProviderAdapter {
    readonly id: DeployCredentialProvider;
    /** Les types de cible qu'il sait déployer : une cible d'un autre type est refusée à l'ajout. */
    readonly kinds: readonly DeployTargetKind[];
    /** Le lieu d'une cible, lisible sans réseau : l'hôte d'une instance, un dépôt. */
    location(access: Pick<ProviderAccess, 'baseUrl'>, target: ProviderTarget): string | null;
    candidates(access: ProviderAccess): Promise<DeployCandidate[]>;
    trigger(
        access: ProviderAccess,
        target: ProviderTarget,
        input: { title: string; description: string }
    ): Promise<void>;
    history(access: ProviderAccess, target: ProviderTarget, options?: ReadOptions): Promise<RemoteDeployment[]>;
    /** Ce que l'avis montre dans son champ Journal : une queue de journal, ou les étapes. */
    noticeLog(
        access: ProviderAccess,
        target: ProviderTarget,
        entry: RemoteDeployment,
        options?: ReadOptions
    ): Promise<string>;
    /** Le journal complet d'un déploiement, pour la fenêtre qui le montre. */
    fullLog(access: ProviderAccess, target: ProviderTarget, entry: RemoteDeployment): Promise<string>;
    /** Pour l'avis. Ne lève jamais : `fallbackName` nomme la cible si le fournisseur se tait. */
    place(
        access: ProviderAccess,
        target: ProviderTarget,
        entry: RemoteDeployment,
        fallbackName: string
    ): Promise<TargetPlace>;
    /** Le dépôt déployé, s'il se connaît ; ne lève jamais. */
    repoUrl(access: ProviderAccess, target: ProviderTarget): Promise<string | null>;
}
