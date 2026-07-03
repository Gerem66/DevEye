import type { CloudSyncEngine } from '@/cloudSync/engine';
import type { Database } from '@/db';
import type Encryption from '@/Services/Encryption';
import type { SecureStore } from '@/Services/SecureStore';
import type { SecretKeyService } from '@/Services/SecretKeyService';
import type { MonitorTransport } from '@/agent/hub';
import type { ErrorCode, LogLevelName } from 'deveye-types';
import type { Logger } from 'pino';
import type { z } from 'zod';

/**
 * An audit event emitted from inside a feature handler. The actor (`uid`, `ip`),
 * channel (`source: web`) and a default `category` (the command's prefix) are
 * filled in by the dispatcher — the handler only describes the event. Provide
 * `category` explicitly to attribute the log to a different subsystem.
 */
export interface FeatureAuditEntry {
    level?: LogLevelName;
    /** Stable dotted event key, e.g. `note.create`. */
    action: string;
    description: string;
    /** Defaults to the command's prefix (e.g. `note` for `note.add`). */
    category?: string;
    metadata?: Record<string, unknown> | null;
}

export interface FeatureContext {
    db: Database;
    /**
     * Raw server-key cipher. Reserved for auth-bound secrets that must be
     * readable without a live user password (e.g. the 2FA secret). Feature data
     * at rest must go through `secure` instead, never `crypt` directly.
     */
    crypt: Encryption;
    /**
     * Unified storage-encryption gateway. The ONLY way features persist or read
     * encrypted data — it transparently applies per-user (and, when enabled,
     * password-based) encryption. Features never touch keys or wrapping.
     */
    secure: SecureStore;
    /** Envelope-key authority backing `secure`; used by the secrecy handlers. */
    secretKeys: SecretKeyService;
    userId: number;
    sessionId: string;
    /** Client IP of the connection (proxy-aware), recorded on audit events. */
    ip: string;
    logger: Logger;
    requestId: string;
    /**
     * Emit an audit log for this action. Fire-and-forget — never awaits the DB
     * write and never throws into the handler. The actor, channel and a default
     * category are pre-bound from the request context.
     */
    audit: (entry: FeatureAuditEntry) => void;
    /** Present only on the live WS connection; enables metric subscriptions. */
    monitor?: MonitorTransport;
    /** CloudSync orchestrator (sessions, versions, blob store). Absent in tests. */
    cloudSync?: CloudSyncEngine;
}

/**
 * Thrown by a feature handler to send a typed error back to the client.
 * The dispatcher converts it into a `protocolError` payload; anything else is
 * mapped to `internal`.
 */
export class FeatureError extends Error {
    constructor(
        public readonly code: ErrorCode,
        message: string,
        public readonly details?: unknown
    ) {
        super(message);
        this.name = 'FeatureError';
    }
}

export interface FeatureDefinition<Cmd extends string, I extends z.ZodTypeAny, O extends z.ZodTypeAny> {
    command: Cmd;
    input: I;
    output: O;
    handler: (ctx: FeatureContext, input: z.infer<I>) => Promise<z.infer<O>>;
}

export function defineFeature<Cmd extends string, I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
    def: FeatureDefinition<Cmd, I, O>
): FeatureDefinition<Cmd, I, O> {
    return def;
}
