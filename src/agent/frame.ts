import { agentClientMessageSchema, type AgentClientMessage } from '@deveye/types';
import type { ZodError } from 'zod';

export type AgentFrame =
    | { ok: true; message: AgentClientMessage }
    | { ok: false; reason: 'json' }
    | { ok: false; reason: 'schema'; error: ZodError };

/** Ce qu'un agent envoie, relu : du JSON, puis le schéma de sa commande. Ne lève jamais. */
export function readAgentFrame(raw: Buffer): AgentFrame {
    let value: unknown;
    try {
        value = JSON.parse(raw.toString());
    } catch {
        return { ok: false, reason: 'json' };
    }
    const parsed = agentClientMessageSchema.safeParse(value);
    return parsed.success ? { ok: true, message: parsed.data } : { ok: false, reason: 'schema', error: parsed.error };
}
