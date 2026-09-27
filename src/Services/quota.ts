import { ACCOUNT_PLAN_PROVIDER, type AccountPlan, type AccountPlanProvider } from '@deveye/types/sdk';
import type { SdkProviders, SdkQuotaUse } from '@deveye/types/sdk/server';

import { FeatureError } from '@deveye/types/sdk/server';

import type { Database } from '@/db';
import { notePlanChangesAt } from '@/Services/planPauses';

interface QuotaLogger {
    error(obj: object, msg: string): void;
}

/**
 * L'offre d'un compte, dite par le module qui en tient une. `null` = aucun
 * fournisseur installé, donc aucune limite : c'est une installation
 * auto-hébergée. Un fournisseur en panne vaut pareil, pour qu'une défaillance
 * de la facturation ne bloque jamais une création.
 */
export async function planOf(
    providers: SdkProviders,
    userId: number,
    logger: QuotaLogger
): Promise<AccountPlan | null> {
    const provider = providers.get<AccountPlanProvider>(ACCOUNT_PLAN_PROVIDER);
    if (!provider) return null;
    try {
        const plan = await provider.planFor(userId);
        // Un essai qui finit ne s'annonce pas : relevé à chaque lecture, pour
        // que la passe des pauses l'attende.
        notePlanChangesAt(userId, plan.changesAt);
        return plan;
    } catch (e) {
        logger.error({ err: (e as Error).message, userId }, 'Offre du compte illisible, aucune limite appliquée');
        return null;
    }
}

/**
 * Pour mettre en pause ou reprendre : jamais d'un cache, et une panne du
 * fournisseur lève au lieu de valoir « illimité ». `null` : aucun fournisseur.
 */
export async function planOfStrict(providers: SdkProviders, userId: number): Promise<AccountPlan | null> {
    const provider = providers.get<AccountPlanProvider>(ACCOUNT_PLAN_PROVIDER);
    return provider ? provider.planFor(userId, { fresh: true }) : null;
}

/** La limite d'une clé `<featureId>.<quotaKey>` pour ce compte, `null` = illimité. */
export function limitIn(plan: AccountPlan | null, fullKey: string): number | null {
    return plan?.limits[fullKey] ?? null;
}

/** Les espaces que possède un compte : ce contre quoi ses quotas se comptent. */
export function ownedWorkspaceIds(db: Pick<Database, 'workspaces'>, userId: number): Promise<number[]> {
    return db.workspaces.listOwnedIds(userId);
}

const SIZE_UNITS = ['o', 'Ko', 'Mo', 'Go', 'To'];

/** Une limite en octets, écrite comme une taille : « 1 Go ». */
export function sizeFr(bytes: number): string {
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${Number.isInteger(value) ? value : value.toFixed(1).replace('.', ',')} ${SIZE_UNITS[unit]}`;
}

export interface PlanLimitCheck {
    /** Le compte dont l'offre s'applique : le propriétaire de l'espace concerné. */
    ownerUserId: number;
    /** `<featureId>.<quotaKey>`, ou `workspace.<clé>` pour ce que le cœur borne lui-même. */
    fullKey: string;
    /** Ce que la limite compte, tel que le refus le dit : « 5 services surveillés ». */
    label: string;
    unit?: 'bytes';
    /** Le total APRÈS création, sur les espaces du propriétaire. Jamais appelé si illimité. */
    countAfter(ownerWorkspaceIds: readonly number[]): Promise<number>;
}

/**
 * La seule comparaison à une offre de toute l'app : les quotas des modules
 * (`_sdk/quota.ts`) et ceux du cœur (espaces, membres) passent par ici.
 */
export async function assertPlanLimit(
    db: Pick<Database, 'workspaces'>,
    providers: SdkProviders,
    logger: QuotaLogger,
    check: PlanLimitCheck
): Promise<void> {
    const plan = await planOf(providers, check.ownerUserId, logger);
    const limit = limitIn(plan, check.fullKey);
    if (limit === null) return;
    const count = await check.countAfter(await ownedWorkspaceIds(db, check.ownerUserId));
    if (count <= limit) return;
    const shown = check.unit === 'bytes' ? sizeFr(limit) : String(limit);
    throw new FeatureError(
        'quota_exceeded',
        `Limite de l'offre ${plan?.label ?? ''} atteinte : ${shown} ${check.label}.`,
        {
            key: check.fullKey,
            limit,
            plan: plan?.id
        }
    );
}

/**
 * Où en est un compte face à une limite : ce qu'un écran dit avant le refus.
 * `null` quand elle est illimitée, et rien n'est compté alors.
 */
export async function planUsage(
    db: Pick<Database, 'workspaces'>,
    providers: SdkProviders,
    logger: QuotaLogger,
    check: { ownerUserId: number; fullKey: string; used(ownerWorkspaceIds: readonly number[]): Promise<number> }
): Promise<SdkQuotaUse | null> {
    const limit = limitIn(await planOf(providers, check.ownerUserId, logger), check.fullKey);
    if (limit === null) return null;
    return { used: await check.used(await ownedWorkspaceIds(db, check.ownerUserId)), limit };
}
