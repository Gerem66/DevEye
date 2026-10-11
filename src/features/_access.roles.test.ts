import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { FeatureAccess, WorkspaceRoleRow } from '@deveye/types';

import { registerModules } from './_sdk/register';
import { roleExceeds } from './_access';

/**
 * Attribuer un rôle ne doit jamais donner plus que ce que l'appelant tient :
 * les niveaux, mais aussi les canaux, le réglage par élément et chaque
 * permission propre, terminal compris.
 */

registerModules([
    {
        manifest: {
            id: 'x-roletest',
            label: 'Test',
            description: 'Module de test des rôles.',
            icon: 'test',
            category: 'daily',
            notifies: false,
            hasItems: false,
            shareTier: 'never',
            resources: [],
            commands: [],
            extraPermissions: [
                { key: 'terminal', label: 'Terminal', description: 'Ouvrir un terminal.', type: 'toggle' },
                {
                    key: 'scope',
                    label: 'Portée',
                    description: 'Ce que l’export couvre.',
                    type: 'choice',
                    options: [
                        { value: 'own', label: 'Le sien' },
                        { value: 'all', label: 'Tout' }
                    ],
                    default: 'own',
                    ownerValue: 'all'
                }
            ]
        },
        server: { features: [] }
    }
]);

function role(grant: Record<string, unknown>): WorkspaceRoleRow {
    return {
        id: 2,
        workspace_id: 1,
        name: 'Support',
        color: '',
        position: 0,
        is_default: 0,
        created: 0,
        capabilities: '[]',
        features: JSON.stringify([{ feature: 'x-roletest', access: 'read', ...grant }])
    };
}

/** Un gestionnaire de membres qui lit la fonctionnalité, sans rien d'autre. */
function caller(extras: Record<string, boolean | string> = {}, over: object = {}) {
    return {
        isOwner: false,
        can: () => false,
        canFeature: (_f: string, level: FeatureAccess = 'read') => level === 'read',
        canChannels: () => false,
        canManageItemGrants: () => false,
        extrasFor: () => extras,
        ...over
    };
}

describe('roleExceeds', () => {
    it('refuse un rôle qui accorde une permission propre que l’appelant ne tient pas', () => {
        assert.equal(roleExceeds(caller(), role({ extras: { terminal: true } })), true);
        assert.equal(roleExceeds(caller({ terminal: true }), role({ extras: { terminal: true } })), false);
    });

    it('un choix au-delà du défaut exige la même valeur chez l’appelant', () => {
        assert.equal(roleExceeds(caller(), role({ extras: { scope: 'all' } })), true);
        assert.equal(roleExceeds(caller({ scope: 'all' }), role({ extras: { scope: 'all' } })), false);
        assert.equal(roleExceeds(caller(), role({ extras: { scope: 'own' } })), false);
    });

    it('compare les canaux et le réglage par élément', () => {
        assert.equal(roleExceeds(caller(), role({ channels: true })), true);
        assert.equal(roleExceeds(caller(), role({ itemPermissions: true })), true);
        assert.equal(
            roleExceeds(caller({}, { canManageItemGrants: () => true }), role({ itemPermissions: true })),
            false
        );
    });

    it('compare le niveau, et laisse le propriétaire tout attribuer', () => {
        assert.equal(roleExceeds(caller(), role({ access: 'write' })), true);
        assert.equal(roleExceeds(caller({}, { isOwner: true }), role({ access: 'write', channels: true })), false);
    });
});
