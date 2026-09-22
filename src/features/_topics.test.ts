import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assertAccessDeclared } from './_permissions';
import { buildTopicIndex } from './_topics';
import { featureHandlers } from './registry';

/**
 * Les deux contrôles de démarrage, joués sur le registre **réel**, modules
 * installés compris.
 *
 * Leur cousin `_permissions.test.ts` vérifie ce que la garde attrape sur des
 * entrées fabriquées ; ici on vérifie qu'elle ne trouve rien à redire de ce qui
 * est vraiment installé. C'est le seul filet : un préfixe de commande absent de
 * `COMMAND_PREFIX_TOPIC` ou un `access` oublié n'apparaissent ni au typecheck ni
 * à `gen:features`, et le smoke qui les verrait a besoin d'une base. Sans ce
 * test, ils ne coûtent qu'un `npm run dev` cassé, et le plus tard possible.
 */
describe('les contrôles de démarrage, sur les features installées', () => {
    it('connaît le sujet de chaque commande', () => {
        assert.doesNotThrow(() => buildTopicIndex());
    });

    it('trouve une garde déclarée sur chaque commande', () => {
        assert.doesNotThrow(() => assertAccessDeclared(featureHandlers));
    });
});
