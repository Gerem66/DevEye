import { deviceTermClose, deviceTermInput, deviceTermOpen, deviceTermResize } from 'deveye-types';

import { defineFeature, FeatureError, type FeatureDefinition } from '../_define';
import { authorizeReachableDevice } from './shared';

/**
 * Open an interactive terminal (PTY) on a device, running the agent user's shell.
 * Owner-or-admin + agent online. The command only opens the session; PTY output
 * streams back as `device.termOutput` push events and the end as `device.termExit`
 * (the caller must be subscribed). A remote shell is a powerful action, so the open
 * is audited (warning).
 */
export const deviceTermOpenFeature: FeatureDefinition<
    typeof deviceTermOpen.command,
    typeof deviceTermOpen.input,
    typeof deviceTermOpen.output
> = defineFeature({
    ...deviceTermOpen,
    handler: async (ctx, input) => {
        const row = await authorizeReachableDevice(ctx, input.deviceId);
        const ok = ctx.monitor?.requestTermOpen(row.id, {
            sessionId: input.sessionId,
            cols: input.cols,
            rows: input.rows,
            user: input.user
        });
        if (!ok) throw new FeatureError('conflict', 'Agent hors ligne');
        ctx.audit({
            action: 'device.terminal',
            level: 'warning',
            description: `Terminal distant ouvert : « ${row.name} »${input.user ? ` (utilisateur ${input.user})` : ''}`,
            metadata: { deviceId: row.id, ownerId: row.owner_id, sessionId: input.sessionId, user: input.user ?? null }
        });
        return { ok: true };
    }
});

/** Send input (keystrokes / paste) to a terminal session. */
export const deviceTermInputFeature: FeatureDefinition<
    typeof deviceTermInput.command,
    typeof deviceTermInput.input,
    typeof deviceTermInput.output
> = defineFeature({
    ...deviceTermInput,
    handler: async (ctx, input) => {
        const row = await authorizeReachableDevice(ctx, input.deviceId);
        const ok = ctx.monitor?.requestTermInput(row.id, { sessionId: input.sessionId, data: input.data });
        if (!ok) throw new FeatureError('conflict', 'Agent hors ligne');
        return { ok: true };
    }
});

/** Resize a terminal session's PTY to match the client viewport. */
export const deviceTermResizeFeature: FeatureDefinition<
    typeof deviceTermResize.command,
    typeof deviceTermResize.input,
    typeof deviceTermResize.output
> = defineFeature({
    ...deviceTermResize,
    handler: async (ctx, input) => {
        const row = await authorizeReachableDevice(ctx, input.deviceId);
        const ok = ctx.monitor?.requestTermResize(row.id, {
            sessionId: input.sessionId,
            cols: input.cols,
            rows: input.rows
        });
        if (!ok) throw new FeatureError('conflict', 'Agent hors ligne');
        return { ok: true };
    }
});

/** Close a terminal session (kills the shell on the device). */
export const deviceTermCloseFeature: FeatureDefinition<
    typeof deviceTermClose.command,
    typeof deviceTermClose.input,
    typeof deviceTermClose.output
> = defineFeature({
    ...deviceTermClose,
    handler: async (ctx, input) => {
        const row = await authorizeReachableDevice(ctx, input.deviceId);
        // A close is best-effort: an offline agent has already torn down its PTYs.
        ctx.monitor?.requestTermClose(row.id, { sessionId: input.sessionId });
        return { ok: true };
    }
});
