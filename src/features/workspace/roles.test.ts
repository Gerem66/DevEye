import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FeatureAccess, WorkspaceFeatureGrant, WorkspaceRoleRow } from '@deveye/types';

import { workspaceFeatureAccessSetFeature } from './roles';

function row(id: number, features: WorkspaceFeatureGrant[], allFeatures = false): WorkspaceRoleRow {
    return {
        id,
        workspace_id: 1,
        name: `Rôle ${id}`,
        color: '#000000',
        position: 0,
        capabilities: '[]',
        features: JSON.stringify(features),
        all_features: allFeatures ? 1 : 0,
        is_default: 0,
        created: 0
    };
}

const grant = (access: FeatureAccess, over: Partial<WorkspaceFeatureGrant> = {}): WorkspaceFeatureGrant => ({
    feature: 'appstores',
    access,
    channels: false,
    itemPermissions: false,
    extras: {},
    ...over
});

async function featureAccessSet(
    rows: WorkspaceRoleRow[],
    grants: { roleId: number; access: FeatureAccess }[],
    writes = new Map<number, WorkspaceFeatureGrant[]>()
) {
    const ctx = {
        workspace: { kind: 'shared' },
        workspaceId: 1,
        db: {
            workspaceRoles: {
                listByWorkspace: async () => rows,
                setFeatures: async (id: number, _workspaceId: number, features: WorkspaceFeatureGrant[]) => {
                    writes.set(id, features);
                }
            }
        },
        audit: () => {}
    } as never;
    const out = await workspaceFeatureAccessSetFeature.handler(ctx, { feature: 'appstores', grants });
    return { out, writes };
}

describe('workspace.featureAccessSet', () => {
    it('pose un grant neuf au seul niveau demandé', async () => {
        const { out, writes } = await featureAccessSet([row(2, [])], [{ roleId: 2, access: 'read' }]);
        assert.deepEqual(out.roleIds, [2]);
        assert.deepEqual(writes.get(2), [grant('read')]);
    });

    it('relève un grant existant en gardant ses réglages', async () => {
        const held = grant('read', { channels: true, itemPermissions: true });
        const { writes } = await featureAccessSet([row(4, [held])], [{ roleId: 4, access: 'write' }]);
        assert.deepEqual(writes.get(4), [{ ...held, access: 'write' }]);
    });

    it('ignore un rôle qui tient tout, et ne fait jamais descendre', async () => {
        const { out, writes } = await featureAccessSet(
            [row(2, [], true), row(3, [grant('write')])],
            [
                { roleId: 2, access: 'write' },
                { roleId: 3, access: 'read' }
            ]
        );
        assert.deepEqual(out.roleIds, []);
        assert.equal(writes.size, 0);
    });

    it('refuse un rôle étranger à l’espace avant toute écriture', async () => {
        const writes = new Map<number, WorkspaceFeatureGrant[]>();
        await assert.rejects(
            featureAccessSet(
                [row(2, [])],
                [
                    { roleId: 2, access: 'read' },
                    { roleId: 9, access: 'read' }
                ],
                writes
            ),
            (e: { code?: string }) => e.code === 'not_found'
        );
        assert.equal(writes.size, 0);
    });
});
