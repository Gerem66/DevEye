import { tasks, type ServiceTask } from '@/Services/tasks';

import { memberVerdict } from '../_access';
import type { FeatureContext } from '../_define';

/**
 * L'opération qu'un membre lance sur une machine, dans sa zone des opérations.
 * Elle y reste tant qu'il lit Appareils et cette machine dans l'espace d'où il
 * l'a lancée ; le verrou de l'appareil la solde à l'issue que l'agent rapporte.
 */
export function openDeviceTask(
    ctx: FeatureContext,
    device: { id: string; name: string },
    opening: { key: string; title: string; detail: string }
): ServiceTask {
    const { db, userId, workspaceId } = ctx;
    return tasks.openService({
        userId,
        workspaceId,
        feature: 'devices',
        itemId: device.id,
        key: opening.key,
        title: opening.title,
        subject: `${device.name} · ${opening.detail}`,
        allowed: async () => (await memberVerdict(db, userId, workspaceId, 'devices', { itemId: device.id })).ok
    });
}
