import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ItemRoleGrantRow } from '@deveye/types';

import type { Database } from '@/db';
import { attachPlanPauses, type PlanPauses } from '@/Services/planPauses';
import { manifest as devicesManifest } from '../../features/devices/src/manifest';
import { registerModules } from './_sdk/register';
import { deviceVerdict, memberVerdict } from './_access';

// Les permissions d'Appareils se résolvent contre son manifest : le vrai, sans
// son partage par élément ni son stock, qui ne sont pas ce qu'on éprouve ici.
registerModules([
    { manifest: { ...devicesManifest, shareTier: 'never', quotas: undefined }, server: { features: [] } }
]);

const OWNER = 1;
const MEMBER = 7;
const WORKSPACE = 1;
const DEVICE = 'dev-a';

interface World {
    suspended?: boolean;
    member?: boolean;
    /** Le grant d'Appareils du rôle du membre ; `null` = rien sur Appareils. */
    grant?: { access: 'read' | 'write'; extras?: Record<string, boolean> } | null;
    overrides?: Pick<ItemRoleGrantRow, 'item_id' | 'access' | 'extra_overrides'>[];
    deviceVisible?: boolean;
}

function fakeDb(world: World): Database {
    const grant = world.grant === undefined ? { access: 'read' as const, extras: { files: true } } : world.grant;
    return {
        users: {
            findById: async (id: number) =>
                id === OWNER || id === MEMBER ? { id, status: world.suspended ? 'suspended' : 'active' } : null
        },
        workspaces: { findById: async (id: number) => (id === WORKSPACE ? { id, owner_user_id: OWNER } : null) },
        workspaceMembers: { isMember: async () => world.member ?? true },
        workspaceRoles: {
            findForMember: async () => ({
                id: 3,
                workspace_id: WORKSPACE,
                name: 'Opérateur',
                color: '',
                position: 0,
                capabilities: '[]',
                features: JSON.stringify(grant ? [{ feature: 'devices', ...grant }] : []),
                is_default: 0,
                created: 0
            })
        },
        itemSharing: {
            grantsForRole: async () =>
                (world.overrides ?? []).map((o) => ({ workspace_id: WORKSPACE, feature: 'devices', role_id: 3, ...o }))
        },
        devices: {
            findVisible: async (id: string) => (world.deviceVisible === false ? null : { id })
        }
    } as unknown as Database;
}

const files = (world: World, userId = MEMBER) => deviceVerdict(fakeDb(world), userId, WORKSPACE, DEVICE, ['files']);

describe('deviceVerdict : les droits d’un membre sur une machine, sans session', () => {
    it('le propriétaire tient tout, un membre ce que son rôle accorde', async () => {
        assert.deepEqual(await files({ grant: null }, OWNER), { ok: true });
        assert.deepEqual(await files({}), { ok: true });
        assert.deepEqual(await files({ grant: { access: 'read', extras: {} } }), { ok: false, reason: 'not_granted' });
        assert.deepEqual(await files({ grant: null }), { ok: false, reason: 'level' });
    });

    it('la surcharge de la machine remplace ce que le rôle donne, dans les deux sens', async () => {
        const noFiles = { access: 'read' as const, extras: {} };
        assert.deepEqual(
            await files({
                grant: noFiles,
                overrides: [{ item_id: DEVICE, access: null, extra_overrides: '{"files":true}' }]
            }),
            { ok: true }
        );
        assert.deepEqual(
            await files({ overrides: [{ item_id: DEVICE, access: null, extra_overrides: '{"files":false}' }] }),
            { ok: false, reason: 'not_granted' }
        );
        assert.deepEqual(await files({ overrides: [{ item_id: DEVICE, access: 'read', extra_overrides: null }] }), {
            ok: false,
            reason: 'read_only'
        });
        assert.deepEqual(await files({ overrides: [{ item_id: DEVICE, access: 'none', extra_overrides: null }] }), {
            ok: false,
            reason: 'hidden'
        });
    });

    it('un compte suspendu, un ancien membre ou une machine d’ailleurs ne passent pas', async () => {
        assert.deepEqual(await files({ suspended: true }), { ok: false, reason: 'suspended' });
        assert.deepEqual(await files({ member: false }), { ok: false, reason: 'not_member' });
        assert.deepEqual(await files({ deviceVisible: false }), { ok: false, reason: 'no_device' });
        assert.deepEqual(await files({}, 99), { ok: false, reason: 'not_member' });
    });
});

describe('memberVerdict : le niveau d’un membre, élément compris', () => {
    it('l’écriture se refuse par le rôle ou par la surcharge de l’élément', async () => {
        const write = (world: World) =>
            memberVerdict(fakeDb(world), MEMBER, WORKSPACE, 'devices', { level: 'write', itemId: DEVICE });
        assert.deepEqual(await write({}), { ok: false, reason: 'level' });
        assert.deepEqual(await write({ grant: { access: 'write' } }), { ok: true });
        assert.deepEqual(
            await write({
                grant: { access: 'write' },
                overrides: [{ item_id: DEVICE, access: 'read', extra_overrides: null }]
            }),
            { ok: false, reason: 'read_only' }
        );
        assert.deepEqual(await write({ overrides: [{ item_id: DEVICE, access: 'write', extra_overrides: null }] }), {
            ok: true
        });
    });
});

describe('memberVerdict : un membre que l’offre du propriétaire tient dehors', () => {
    it('perd l’accès, espace en pause ou lui-même en pause, et le propriétaire jamais', async () => {
        const read = (userId = MEMBER) => memberVerdict(fakeDb({}), userId, WORKSPACE, 'devices', { level: 'read' });
        const paused = new Set<string>();
        attachPlanPauses({ isPaused: (key: string, id: string) => paused.has(`${key}/${id}`) } as PlanPauses);
        try {
            assert.deepEqual(await read(), { ok: true });
            paused.add(`workspace.members/${WORKSPACE}:${MEMBER}`);
            assert.deepEqual(await read(), { ok: false, reason: 'not_member' });
            paused.clear();
            paused.add(`workspace.shared/${WORKSPACE}`);
            assert.deepEqual(await read(), { ok: false, reason: 'not_member' });
            assert.deepEqual(await read(OWNER), { ok: true });
        } finally {
            attachPlanPauses(null);
        }
    });
});
