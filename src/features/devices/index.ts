import {
    deviceConfirm,
    deviceDelete,
    deviceList,
    deviceRename,
    deviceRevoke,
    type Device,
    type DeviceRow
} from 'deveye-types';

import { deviceRowToDevice } from '@/agent/mappers';
import { defineFeature, FeatureError, type FeatureContext, type FeatureDefinition } from '../_define';

async function isAdmin(ctx: FeatureContext): Promise<boolean> {
    const user = await ctx.db.users.findById(ctx.userId);
    return user?.role === 'admin';
}

/** Load a device the caller is allowed to manage (owner or admin), else throw. */
async function authorizeDevice(ctx: FeatureContext, deviceId: string): Promise<DeviceRow> {
    const row = await ctx.db.devices.findById(deviceId);
    if (!row) throw new FeatureError('not_found', 'Device not found');
    if (row.owner_id !== ctx.userId && !(await isAdmin(ctx))) {
        throw new FeatureError('forbidden', 'Not allowed to manage this device');
    }
    return row;
}

function online(ctx: FeatureContext, ids: string[]): Record<string, boolean> {
    return ctx.monitor?.isOnline(ids) ?? Object.fromEntries(ids.map((id) => [id, false]));
}

function toDevice(ctx: FeatureContext, row: DeviceRow): Device {
    return deviceRowToDevice(row, online(ctx, [row.id])[row.id] ?? false);
}

export const deviceListFeature: FeatureDefinition<
    typeof deviceList.command,
    typeof deviceList.input,
    typeof deviceList.output
> = defineFeature({
    ...deviceList,
    handler: async (ctx) => {
        const rows = (await isAdmin(ctx))
            ? await ctx.db.devices.listAll()
            : await ctx.db.devices.listByOwner(ctx.userId);
        const presence = online(
            ctx,
            rows.map((r) => r.id)
        );
        return { devices: rows.map((r) => deviceRowToDevice(r, presence[r.id] ?? false)) };
    }
});

export const deviceConfirmFeature: FeatureDefinition<
    typeof deviceConfirm.command,
    typeof deviceConfirm.input,
    typeof deviceConfirm.output
> = defineFeature({
    ...deviceConfirm,
    handler: async (ctx, input) => {
        const row = await authorizeDevice(ctx, input.deviceId);
        if (row.status === 'revoked') throw new FeatureError('conflict', 'Device is revoked');
        await ctx.db.devices.setStatus(row.id, 'active');
        const updated = await ctx.db.devices.findById(row.id);
        return { device: toDevice(ctx, updated ?? { ...row, status: 'active' }) };
    }
});

export const deviceRevokeFeature: FeatureDefinition<
    typeof deviceRevoke.command,
    typeof deviceRevoke.input,
    typeof deviceRevoke.output
> = defineFeature({
    ...deviceRevoke,
    handler: async (ctx, input) => {
        const row = await authorizeDevice(ctx, input.deviceId);
        await ctx.db.devices.setStatus(row.id, 'revoked');
        const updated = await ctx.db.devices.findById(row.id);
        return { device: toDevice(ctx, updated ?? { ...row, status: 'revoked' }) };
    }
});

export const deviceRenameFeature: FeatureDefinition<
    typeof deviceRename.command,
    typeof deviceRename.input,
    typeof deviceRename.output
> = defineFeature({
    ...deviceRename,
    handler: async (ctx, input) => {
        const row = await authorizeDevice(ctx, input.deviceId);
        await ctx.db.devices.rename(row.id, input.name);
        const updated = await ctx.db.devices.findById(row.id);
        return { device: toDevice(ctx, updated ?? { ...row, name: input.name }) };
    }
});

export const deviceDeleteFeature: FeatureDefinition<
    typeof deviceDelete.command,
    typeof deviceDelete.input,
    typeof deviceDelete.output
> = defineFeature({
    ...deviceDelete,
    handler: async (ctx, input) => {
        const row = await authorizeDevice(ctx, input.deviceId);
        await ctx.db.devices.delete(row.id);
        return { deviceId: row.id };
    }
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const deviceFeatures: FeatureDefinition<string, any, any>[] = [
    deviceListFeature,
    deviceConfirmFeature,
    deviceRevokeFeature,
    deviceRenameFeature,
    deviceDeleteFeature
];
