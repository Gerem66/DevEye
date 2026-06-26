import { deviceUpdateAgent, isNewerVersion } from 'deveye-types';

import { agentDistDir, readServedManifestCached } from '@/agent/sync';
import { defineFeature, FeatureError, type FeatureDefinition } from '../_define';
import { assertAdmin, authorizeDevice, online, toDevice } from './shared';

/**
 * Push a signed self-update to a connected agent. The server resolves the newer
 * signed binary for the device's build target and sends `agent.update`.
 */
export const deviceUpdateAgentFeature: FeatureDefinition<
    typeof deviceUpdateAgent.command,
    typeof deviceUpdateAgent.input,
    typeof deviceUpdateAgent.output
> = defineFeature({
    ...deviceUpdateAgent,
    handler: async (ctx, input) => {
        await assertAdmin(ctx);
        const row = await authorizeDevice(ctx, input.deviceId);
        // Pre-flight: the agent must be reachable, must have told us its build
        // target, and we must hold a NEWER, SIGNED binary for it. Each gate maps
        // to a clear French error so the UI can explain why the button did nothing.
        if (!(online(ctx, [row.id])[row.id] ?? false)) {
            throw new FeatureError('conflict', 'Agent hors ligne');
        }
        if (!row.agent_target) {
            throw new FeatureError('conflict', "L'agent ne supporte pas encore la mise à jour automatique");
        }
        const manifest = await readServedManifestCached(agentDistDir());
        const target = manifest?.targets.find((t) => t.id === row.agent_target);
        if (!manifest || !target) {
            throw new FeatureError('conflict', 'Aucun binaire disponible pour cette plateforme');
        }
        if (!target.signature) {
            throw new FeatureError('conflict', 'Binaire non signé : mise à jour refusée');
        }
        // Only ever push an upgrade: refuse when the served version isn't strictly
        // newer than what's running (already up to date, or — after a rollback — older).
        if (!row.agent_version || !isNewerVersion(manifest.version, row.agent_version)) {
            throw new FeatureError('conflict', "L'agent est déjà à jour");
        }

        const pushed =
            ctx.monitor?.requestUpdate(row.id, {
                targetId: target.id,
                version: manifest.version,
                sha256: target.sha256,
                signature: target.signature
            }) ?? false;
        if (!pushed) throw new FeatureError('conflict', 'Agent hors ligne');

        ctx.audit({
            action: 'device.updateAgent',
            level: 'warning',
            description: `Mise à jour de l'agent demandée : « ${row.name} » ${row.agent_version ?? '?'} → ${manifest.version}`,
            metadata: {
                deviceId: row.id,
                ownerId: row.owner_id,
                from: row.agent_version,
                to: manifest.version,
                target: target.id
            }
        });
        const updated = (await ctx.db.devices.findById(row.id)) ?? row;
        return { device: await toDevice(ctx, updated) };
    }
});
