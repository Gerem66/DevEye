import type { Database } from '@/db';
import type Encryption from '@/Services/Encryption';
import type { SecureStore } from '@/Services/SecureStore';
import type { SecretKeyService } from '@/Services/SecretKeyService';
import type { MonitorTransport } from '@/agent/hub';
import type { ErrorCode } from 'deveye-types';
import type { Logger } from 'pino';
import type { z } from 'zod';

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
    logger: Logger;
    requestId: string;
    /** Present only on the live WS connection; enables metric subscriptions. */
    monitor?: MonitorTransport;
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
