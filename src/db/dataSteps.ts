import type { FeatureDataStep, FeatureDataStepContext } from '@deveye/types/sdk/server';

import { logger } from '@/logger';
import type { Database } from './index';

/**
 * Les étapes de données : les reprises qu'un module écrit en TypeScript parce
 * qu'il leur faut une clé (recalculer un condensé, sceller une colonne). Jouées
 * une fois chacune au démarrage, après les migrations et avant tout service,
 * et notées dans `_data_steps` sous `<module>/<id>`.
 *
 * Une étape qui lève arrête le démarrage, comme une migration : le serveur ne
 * part pas sur des lignes à moitié reprises.
 */
export interface ModuleDataSteps {
    /** L'id du module : le préfixe sous lequel ses étapes s'enregistrent. */
    id: string;
    steps: readonly FeatureDataStep<unknown>[];
    /** Le contexte d'une étape, sur les dépôts de `db` : ceux d'une transaction pour une étape atomique. */
    context(db: Database): FeatureDataStepContext<unknown>;
}

export async function runDataSteps(db: Database, modules: readonly ModuleDataSteps[]): Promise<void> {
    const applied = new Set(await db.dataSteps.applied());
    for (const mod of modules) {
        const seen = new Set<string>();
        for (const step of mod.steps) {
            const name = `${mod.id}/${step.id}`;
            if (seen.has(step.id)) throw new Error(`Étape de données déclarée deux fois : ${name}`);
            seen.add(step.id);
            if (applied.has(name)) continue;

            logger.info({ step: name }, 'Étape de données : départ');
            const started = Date.now();
            try {
                if (step.atomic) {
                    // L'étape et sa note dans la même transaction : appliquée et notée, ou ni l'un ni l'autre.
                    await db.transaction(async (tx) => {
                        await step.run(mod.context(tx));
                        await tx.dataSteps.record(name);
                    });
                } else {
                    await step.run(mod.context(db));
                    await db.dataSteps.record(name);
                }
            } catch (cause) {
                throw new Error(`Étape de données ${name} : ${(cause as Error).message}`, { cause });
            }
            logger.info({ step: name, ms: Date.now() - started }, 'Étape de données : faite');
        }
    }
}
