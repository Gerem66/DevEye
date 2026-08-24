import { logLevelValue, type LogLevelName, type LogSource } from '@deveye/types';

import { logger } from '@/logger';
import type { Database } from '@/db';

/**
 * A single auditable event. The emitter supplies the *what* (`action`,
 * `description`, optional structured `metadata`) and the *who/where*
 * (`uid`, `ip`, `source`, `category`); `level` defaults to `info`.
 *
 * `action` is the stable event key the Logs feature filters on (e.g.
 * `login.failed`, `note.create`) — keep it short and dotted; put human-readable
 * detail in `description` and machine-readable detail in `metadata`.
 */
export interface AuditEvent {
    level?: LogLevelName;
    source: LogSource;
    category: string;
    action: string;
    /** Acting user id; 0 for system / unauthenticated. */
    uid: number;
    ip: string;
    description: string;
    metadata?: Record<string, unknown> | null;
}

/**
 * The single sink every feature, auth route and subsystem writes audit events
 * to. `record` is intentionally fire-and-forget (returns `void`): logging must
 * never slow down or fail the action it describes, so a DB error here is caught
 * and reported to the server logger rather than propagated to the caller.
 */
export interface AuditLog {
    record(event: AuditEvent): void;
}

export function createAuditLog(db: Database): AuditLog {
    return {
        record(event) {
            void db.logs
                .record({
                    uid: event.uid,
                    ip: event.ip,
                    source: event.source,
                    category: event.category,
                    action: event.action,
                    level: logLevelValue(event.level ?? 'info'),
                    description: event.description,
                    metadata: event.metadata ?? null
                })
                .catch((err: unknown) => {
                    logger.error(
                        { err: err instanceof Error ? err.message : String(err), action: event.action },
                        'Failed to write audit log'
                    );
                });
        }
    };
}
