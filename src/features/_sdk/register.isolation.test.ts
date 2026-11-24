import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isolationProblems } from '@deveye/types/sdk/server';

import { INSTALLED_MODULES } from '@/features/_generated/installed';
import { LOCAL_MODULES } from '@/features/_generated/installed.local';

/**
 * Le cloisonnement à l'exécution, module par module : un module qui déclare
 * ses sondes (`e2e.isolation`) couvre chaque commande qui prend un identifiant,
 * et une commande ajoutée sans sonde échoue ici.
 *
 * `PENDING` : les modules du dépôt qui n'ont pas encore leurs sondes. La liste
 * ne peut que rétrécir : un module neuf n'y entre pas, il déclare les siennes.
 */
const PENDING = new Set([
    'appstores',
    'audience',
    'backup',
    'convert',
    'cve',
    'database',
    'deploy',
    'devices',
    'finance',
    'git',
    'invoicing',
    'mail',
    'mailserver',
    'password',
    'pdf',
    'projects',
    'sentinel',
    'shortlinks',
    'uptime',
    'weather',
    'whiteboard',
    'x-moderation'
]);

const repoModules = INSTALLED_MODULES.filter((mod) => !LOCAL_MODULES.includes(mod));

describe('les sondes de cloisonnement des modules', () => {
    for (const mod of INSTALLED_MODULES) {
        const isolation = mod.server.e2e?.isolation;
        if (!isolation) continue;
        it(`${mod.manifest.id} : chaque commande à identifiant a sa sonde, chaque sonde est valide`, () => {
            assert.deepEqual(isolationProblems(mod.server.features, isolation), []);
        });
    }

    it('tout module du dépôt a ses sondes, ou figure parmi ceux qui les attendent', () => {
        const missing = repoModules
            .filter((mod) => !mod.server.e2e?.isolation && !PENDING.has(mod.manifest.id))
            .map((mod) => mod.manifest.id);
        assert.deepEqual(missing, []);
    });

    it('la liste d’attente ne garde pas un module qui a ses sondes, ni un module disparu', () => {
        const stale = [...PENDING].filter((id) => {
            const mod = repoModules.find((m) => m.manifest.id === id);
            return !mod || mod.server.e2e?.isolation !== undefined;
        });
        assert.deepEqual(stale, []);
    });
});
