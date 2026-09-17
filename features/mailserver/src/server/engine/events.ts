import type { SdkCipher } from '@deveye/types/sdk/server';

import type { AuthVerdict, MailEventKind } from '../../contracts/domain';
import { dayOf, now, seal } from '../_shared';
import type { DailyColumn, MailboxRow, MailserverRepo } from '../repo';

/** Le journal d'une boîte et ses compteurs du jour, puis le battement qui rafraîchit les écrans. */

export interface EventInput {
    kind: MailEventKind;
    size?: number;
    spf?: AuthVerdict;
    dkim?: AuthVerdict;
    dmarc?: AuthVerdict;
    peer: string;
    detail?: string;
}

export interface EventRecorder {
    record(mailbox: MailboxRow, event: EventInput): Promise<void>;
    stop(): void;
}

const VERDICT: Record<AuthVerdict, number> = { none: 0, pass: 1, fail: 2 };

const COUNTED: Partial<Record<MailEventKind, DailyColumn>> = {
    received: 'received',
    junked: 'received',
    rejected: 'rejected',
    sent: 'sent',
    bounced: 'bounced'
};

/** Une boîte qui reçoit cent messages en une minute ne fait pas recharger cent fois les écrans. */
const BEAT_MS = 10_000;

export function createEventRecorder(deps: {
    repo: MailserverRepo;
    cipherFor(workspaceId: number): SdkCipher;
    beat(workspaceId: number): void;
}): EventRecorder {
    const pending = new Map<number, ReturnType<typeof setTimeout>>();

    const scheduleBeat = (workspaceId: number): void => {
        if (pending.has(workspaceId)) return;
        const timer = setTimeout(() => {
            pending.delete(workspaceId);
            deps.beat(workspaceId);
        }, BEAT_MS);
        timer.unref();
        pending.set(workspaceId, timer);
    };

    return {
        async record(mailbox, event) {
            const ts = now();
            await deps.repo.insertEvent({
                mailboxId: mailbox.id,
                ts,
                kind: event.kind,
                size: event.size ?? 0,
                spf: VERDICT[event.spf ?? 'none'],
                dkim: VERDICT[event.dkim ?? 'none'],
                dmarc: VERDICT[event.dmarc ?? 'none'],
                content: await seal(deps.cipherFor(mailbox.workspace_id), {
                    peer: event.peer.slice(0, 320),
                    detail: (event.detail ?? '').slice(0, 300)
                })
            });
            const column = COUNTED[event.kind];
            if (column) await deps.repo.bumpDaily(mailbox.id, dayOf(ts), column);
            scheduleBeat(mailbox.workspace_id);
        },
        stop() {
            for (const timer of pending.values()) clearTimeout(timer);
            pending.clear();
        }
    };
}
