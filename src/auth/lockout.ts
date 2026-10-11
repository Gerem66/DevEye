import { err } from '@deveye/types';
import type { FastifyReply } from 'fastify';

import { assertAttemptAllowed, LockedOutError, type AttemptScope } from '@/Services/attempts';

/** Le refus d'une cible verrouillée, sous la forme HTTP. `false` = pas verrouillée. */
export function lockedOut(reply: FastifyReply, scope: AttemptScope, key: string): FastifyReply | false {
    try {
        assertAttemptAllowed(scope, key);
        return false;
    } catch (e) {
        if (!(e instanceof LockedOutError)) throw e;
        return reply
            .code(429)
            .header('retry-after', Math.ceil(e.retryAfterMs / 1000))
            .send(err('rate_limited', e.message, { retryAfterMs: e.retryAfterMs }));
    }
}
