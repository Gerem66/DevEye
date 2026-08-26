import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Logger } from 'pino';
import type { ExternalFeatureId } from '@deveye/types';
import type { FeatureManifest } from '@deveye/types/sdk';
import type { FeatureServer } from '@deveye/types/sdk/server';

import { createModuleServices, registerModules } from './register';
import type { ModuleServiceHost } from './service';

/**
 * La sentinelle des providers : deux modules qui offrent le même contrat se
 * refusent à la création des services (`moduleProvider` n'aurait aucun
 * critère pour en choisir un).
 *
 * Dans son propre fichier, donc son propre processus : `createModuleServices`
 * avorte à mi-course en laissant les services déjà créés dans le registre
 * (état de module sans remise à zéro), ce qui fausserait tout test voisin qui
 * compterait des hooks ou des services. Rien d'autre n'est enregistré ici.
 */

function manifest(id: ExternalFeatureId): FeatureManifest {
    return {
        id,
        label: 'Test',
        description: 'Module de test des providers.',
        icon: 'test',
        category: 'daily',
        notifies: false,
        hasItems: false,
        shareTier: 'never',
        resources: [],
        commands: []
    };
}

function offering(key: string, value: unknown): FeatureServer {
    return {
        features: [],
        createService: () => ({ start() {}, stop() {}, providers: { [key]: value } })
    };
}

const logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
const host = { db: { queryable: {} }, crypt: {}, audit: { record() {} }, logger } as unknown as ModuleServiceHost;

registerModules([
    { manifest: manifest('x-sdkprovone'), server: offering('shared', 1) },
    { manifest: manifest('x-sdkprovtwo'), server: offering('shared', 2) }
]);

describe("createModuleServices : un provider n'a qu'un offreur", () => {
    it('refuse la seconde offre en nommant les deux modules', () => {
        assert.throws(
            () => createModuleServices(host),
            /Provider « shared » offert par « x-sdkprovone » et « x-sdkprovtwo »/
        );
    });
});
