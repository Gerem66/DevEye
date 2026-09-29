import type { BootTask, ServerStatus } from '@deveye/types';

import { appVersion } from './version';

/**
 * Process-wide readiness registry. Boot/deployment tasks (today: the agent
 * reconcile) register here and report progress; the web client polls
 * `GET /api/status` and shows a discreet topbar zone until `ready` is true.
 *
 * It is a module singleton on purpose: readiness is a property of the process,
 * not of any request or connection.
 */
class StatusStore {
    private tasks = new Map<string, BootTask>();

    /** Declare a task up front (state `pending`) so the UI shows "not ready" immediately. */
    register(id: string, label: string): void {
        if (this.tasks.has(id)) return;
        this.tasks.set(id, { id, label, state: 'pending', progress: null, detail: null, error: null });
    }

    update(id: string, patch: Partial<Omit<BootTask, 'id' | 'label'>>): void {
        const current = this.tasks.get(id);
        if (!current) return;
        this.tasks.set(id, { ...current, ...patch });
    }

    /** L'état du démarrage. Ce que le serveur dit de sa configuration s'y ajoute à la route (`app.ts`). */
    snapshot(): Omit<ServerStatus, 'federation' | 'statusPageUrl'> {
        const tasks = [...this.tasks.values()];
        // No tasks → ready. Otherwise ready only when every task has settled `done`.
        const ready = tasks.every((t) => t.state === 'done');
        return { ready, version: appVersion(), tasks };
    }
}

export const status = new StatusStore();
