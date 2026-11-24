import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FeatureDataStepContext } from '@deveye/types/sdk/server';

import { runDataSteps, type ModuleDataSteps } from './dataSteps';
import type { Database } from './index';

/** Une base réduite à son registre d'étapes, qui note ce qui s'est écrit dans une transaction. */
function fakeDb(applied: string[] = []) {
    const recorded = [...applied];
    const log: string[] = [];
    const make = (inTransaction: boolean): Database =>
        ({
            dataSteps: {
                applied: async () => [...recorded],
                record: async (name: string) => {
                    recorded.push(name);
                    log.push(`${inTransaction ? 'tx ' : ''}note ${name}`);
                }
            },
            transaction: async <T>(fn: (db: Database) => Promise<T>): Promise<T> => {
                const before = recorded.length;
                log.push('début');
                try {
                    const out = await fn(make(true));
                    log.push('validée');
                    return out;
                } catch (error) {
                    recorded.length = before;
                    log.push('annulée');
                    throw error;
                }
            },
            inTransaction
        }) as unknown as Database;
    return { db: make(false), recorded, log };
}

function moduleOf(id: string, steps: ModuleDataSteps['steps'], log: string[]): ModuleDataSteps {
    return {
        id,
        steps,
        context: (db) => {
            log.push((db as unknown as { inTransaction: boolean }).inTransaction ? 'contexte tx' : 'contexte');
            return {} as FeatureDataStepContext<unknown>;
        }
    };
}

describe('les étapes de données', () => {
    it('joue chaque étape une fois, dans l’ordre des modules puis du module, et la note', async () => {
        const { db, recorded, log } = fakeDb(['database/001-a']);
        const ran: string[] = [];
        const step = (id: string) => ({ id, run: async () => void ran.push(id) });
        await runDataSteps(db, [
            moduleOf('database', [step('001-a'), step('002-b')], log),
            moduleOf('git', [step('001-a')], log)
        ]);
        assert.deepEqual(ran, ['002-b', '001-a']);
        assert.deepEqual(recorded, ['database/001-a', 'database/002-b', 'git/001-a']);

        await runDataSteps(db, [moduleOf('database', [step('001-a'), step('002-b')], log)]);
        assert.deepEqual(ran, ['002-b', '001-a']);
    });

    it('s’arrête à l’étape qui lève, sans la noter ni jouer les suivantes', async () => {
        const { db, recorded, log } = fakeDb();
        const ran: string[] = [];
        await assert.rejects(
            runDataSteps(db, [
                moduleOf(
                    'database',
                    [
                        { id: '001-a', run: async () => void ran.push('a') },
                        {
                            id: '002-b',
                            run: async () => {
                                throw new Error('clé de l’espace 8 illisible');
                            }
                        },
                        { id: '003-c', run: async () => void ran.push('c') }
                    ],
                    log
                )
            ]),
            /Étape de données database\/002-b : clé de l’espace 8 illisible/
        );
        assert.deepEqual(ran, ['a']);
        assert.deepEqual(recorded, ['database/001-a']);
    });

    it('note une étape atomique dans sa propre transaction, et rien si elle lève', async () => {
        const { db, recorded, log } = fakeDb();
        await runDataSteps(db, [
            moduleOf('audit', [{ id: '001-wrap', atomic: true, run: async () => undefined }], log)
        ]);
        assert.deepEqual(log, ['début', 'contexte tx', 'tx note audit/001-wrap', 'validée']);
        assert.deepEqual(recorded, ['audit/001-wrap']);

        await assert.rejects(
            runDataSteps(db, [
                moduleOf(
                    'audit',
                    [
                        {
                            id: '002-wrap',
                            atomic: true,
                            run: async () => {
                                throw new Error('à mi-chemin');
                            }
                        }
                    ],
                    log
                )
            ]),
            /audit\/002-wrap/
        );
        assert.equal(log.at(-1), 'annulée');
        assert.deepEqual(recorded, ['audit/001-wrap']);
    });

    it('refuse un module qui déclare deux fois la même étape', async () => {
        const { db, log } = fakeDb();
        const step = { id: '001-a', run: async () => undefined };
        await assert.rejects(runDataSteps(db, [moduleOf('git', [step, step], log)]), /déclarée deux fois : git\/001-a/);
    });
});
