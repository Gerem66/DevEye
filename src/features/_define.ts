import type { Database } from '@/db';
import type Encryption from '@/Services/Encryption';
import type { ErrorCode } from 'deveye-types';
import type { Logger } from 'pino';
import type { z } from 'zod';

export interface FeatureContext {
    db: Database;
    crypt: Encryption;
    userId: number;
    sessionId: string;
    logger: Logger;
    requestId: string;
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
