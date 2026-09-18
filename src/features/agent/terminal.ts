import { agentTermClose, agentTermInput, agentTermOpen, agentTermResize } from '@deveye/types';

import { authorizeReachableDevice } from '@/agent/authorize';
import { defineFeature, FeatureError, type FeatureContext, type FeatureDefinition } from '../_define';

function assertOwnsSession(ctx: FeatureContext, sessionId: string): void {
    if (!ctx.monitor?.ownsTermSession(sessionId)) {
        throw new FeatureError('forbidden', 'Cette session de terminal n’est pas la vôtre');
    }
}

/**
 * Open an interactive terminal (PTY) on a device, running the agent user's shell.
 * Needs the `terminal` permission on Appareils + agent online. The command only
 * opens the session; PTY output streams back as `device.termOutput` push events
 * and the end as `device.termExit`, to the opening connection only: a shell
 * belongs to whoever opened it, and input is accepted from that connection
 * alone. A remote shell is a powerful action, so the open is audited (warning).
 */
export const agentTermOpenFeature: FeatureDefinition<
    typeof agentTermOpen.command,
    typeof agentTermOpen.input,
    typeof agentTermOpen.output
> = defineFeature({
    ...agentTermOpen,
    access: { feature: 'devices', extras: ['terminal'] },
    handler: async (ctx, input) => {
        const row = await authorizeReachableDevice(ctx, input.deviceId);
        const ok = ctx.monitor?.requestTermOpen(row.id, {
            sessionId: input.sessionId,
            cols: input.cols,
            rows: input.rows,
            user: input.user
        });
        if (!ok) throw new FeatureError('conflict', 'Agent hors ligne, ou session déjà ouverte');
        ctx.audit({
            action: 'agent.terminal',
            level: 'warning',
            description: `Terminal distant ouvert : « ${row.name} »${input.user ? ` (utilisateur ${input.user})` : ''}`,
            metadata: { deviceId: row.id, ownerId: row.owner_id, sessionId: input.sessionId, user: input.user ?? null }
        });
        return { ok: true };
    }
});

/** Send input (keystrokes / paste) to a terminal session. */
export const agentTermInputFeature: FeatureDefinition<
    typeof agentTermInput.command,
    typeof agentTermInput.input,
    typeof agentTermInput.output
> = defineFeature({
    ...agentTermInput,
    access: { feature: 'devices', extras: ['terminal'] },
    handler: async (ctx, input) => {
        const row = await authorizeReachableDevice(ctx, input.deviceId);
        assertOwnsSession(ctx, input.sessionId);
        const ok = ctx.monitor?.requestTermInput(row.id, { sessionId: input.sessionId, data: input.data });
        if (!ok) throw new FeatureError('conflict', 'Agent hors ligne');
        return { ok: true };
    }
});

/** Resize a terminal session's PTY to match the client viewport. */
export const agentTermResizeFeature: FeatureDefinition<
    typeof agentTermResize.command,
    typeof agentTermResize.input,
    typeof agentTermResize.output
> = defineFeature({
    ...agentTermResize,
    access: { feature: 'devices', extras: ['terminal'] },
    handler: async (ctx, input) => {
        const row = await authorizeReachableDevice(ctx, input.deviceId);
        assertOwnsSession(ctx, input.sessionId);
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
export const agentTermCloseFeature: FeatureDefinition<
    typeof agentTermClose.command,
    typeof agentTermClose.input,
    typeof agentTermClose.output
> = defineFeature({
    ...agentTermClose,
    access: { feature: 'devices', extras: ['terminal'] },
    handler: async (ctx, input) => {
        const row = await authorizeReachableDevice(ctx, input.deviceId);
        assertOwnsSession(ctx, input.sessionId);
        // A close is best-effort: an offline agent has already torn down its PTYs.
        ctx.monitor?.requestTermClose(row.id, { sessionId: input.sessionId });
        return { ok: true };
    }
});
