import type { Logger } from 'pino';
import type { FeatureService } from '@deveye/types/sdk/server';

import type { MonitorHub } from '@/agent/hub';
import type { Database } from '@/db';
import { FeatureError } from '@/features/_define';
import { ORIGINS } from '@/features/_sdk/context';
import type { LiveHub } from '@/live/hub';
import type { AuditLog } from '@/Services/AuditLog';
import type Encryption from '@/Services/Encryption';
import type { Mailer } from '@/Services/mailer';
import { env } from '@/Utils/Env';
import { appVersion } from '@/version';
import { createBench, type Bench } from './bench';
import { createE2e, type E2e } from './e2e';
import { mailbox } from './e2e/mailbox';
import { createMailTester, type MailTester } from './mail';
import { createRunRegistry, type RunRegistry } from './runs';
import { selfTracking } from './selfTracking';

/**
 * La page « Tests et débogage » : essais de bout en bout, mesures, testeur de
 * mails et suivi d'usage. Les commandes (`features/debug`) ne font que
 * valider et déléguer ici ; chaque sous-dossier est indépendant des autres,
 * sauf `runs`, que les essais et les mesures partagent.
 */

export interface DebugDeps {
    db: Database;
    crypt: Encryption;
    live: LiveHub;
    hub: MonitorHub;
    audit: AuditLog;
    logger: Logger;
    /** L'expéditeur du serveur, derrière la boîte des essais. */
    mailer: Mailer;
    signupOpen(): Promise<boolean>;
}

export interface DebugHost {
    deps: DebugDeps;
    runs: RunRegistry;
    bench: Bench;
    e2e: E2e;
    mail: MailTester;
    instance(): { origin: string; environment: 'dev' | 'test' | 'prod'; version: string; startedAt: number };
}

let host: DebugHost | null = null;

/** Pour les commandes : le service est créé au démarrage, avant la première socket. */
export function debugHost(): DebugHost {
    if (!host) throw new FeatureError('internal', 'La page de débogage n’est pas prête');
    return host;
}

export function createDebugService(deps: DebugDeps): FeatureService {
    const startedAt = Math.round(Date.now() - process.uptime() * 1000);
    const runs = createRunRegistry({ db: deps.db, origin: ORIGINS.app, logger: deps.logger });
    const e2e = createE2e({
        db: deps.db,
        live: deps.live,
        mailer: deps.mailer,
        mailbox,
        origins: ORIGINS,
        signupOpen: deps.signupOpen,
        runs,
        audit: deps.audit,
        logger: deps.logger
    });
    host = {
        deps,
        runs,
        bench: createBench({
            db: deps.db,
            crypt: deps.crypt,
            mailer: deps.mailer,
            origin: ORIGINS.app,
            runs,
            wsSockets: () => deps.live.socketCount(),
            agentsOnline: () => deps.hub.onlineCount()
        }),
        e2e,
        mail: createMailTester({ db: deps.db, mailer: deps.mailer }),
        instance: () => ({ origin: ORIGINS.app, environment: env.ENVIRONMENT, version: appVersion(), startedAt })
    };
    let cancelBootSweep: (() => void) | null = null;
    return {
        async start() {
            await runs.recover();
            await selfTracking.init(deps.db);
            cancelBootSweep = e2e.scheduleBootSweep();
        },
        async stop() {
            cancelBootSweep?.();
            await runs.shutdown();
        }
    };
}
