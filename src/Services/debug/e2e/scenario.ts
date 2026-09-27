import type { SdkE2eContext, SdkE2eScenario, SdkOrigins } from '@deveye/types/sdk/server';

import type { Database } from '@/db';
import type { LiveHub } from '@/live/hub';
import { maintenance } from '@/Services/maintenance';
import type { Mailer } from '@/Services/mailer';
import type { TestSession } from './accounts';
import type { TestClient } from './client';
import type { TestIdentity } from './identity';
import type { Ledger } from './ledger';
import type { Mailbox } from './mailbox';

export interface E2eDeps {
    db: Database;
    live: LiveHub;
    /** L'expéditeur du serveur derrière la boîte des essais. */
    mailer: Mailer;
    mailbox: Mailbox;
    origins: SdkOrigins;
    signupOpen(): Promise<boolean>;
}

export interface E2eContext {
    deps: E2eDeps;
    signal: AbortSignal;
    /** Les comptes jetables que le scénario a demandés, connectés. */
    accounts: TestSession[];
    newIdentity(): TestIdentity;
    /** Un navigateur de plus, sans session, fermé à la fin du scénario. */
    newClient(): TestClient;
    ledger: Ledger;
    state: Map<string, unknown>;
    /** Le vrai chemin de suppression d'un compte jetable, au nom de qui a lancé l'essai. */
    removeAccount(account: { userId: number; email: string }): Promise<void>;
}

export interface E2eStep {
    label: string;
    timeoutMs?: number;
    /** Lève pour échouer ; une chaîne rendue devient le détail de l'étape. */
    run(ctx: E2eContext): Promise<string | void>;
}

export interface E2eScenario {
    /** `<source>.<id>`. */
    id: string;
    label: string;
    sourceLabel: string;
    /** Les comptes jetables ouverts et connectés avant la première étape. */
    accounts: 0 | 1 | 2;
    skip?(deps: E2eDeps): Promise<string | null> | string | null;
    steps: readonly E2eStep[];
}

export function check(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

/** Un refus attendu, et pas un autre : `forbidden` pour une porte fermée, pas un plantage. */
export async function expectRefusal(attempt: Promise<unknown>, code: string): Promise<void> {
    try {
        await attempt;
    } catch (e) {
        const got = (e as { code?: string }).code;
        if (got === code) return;
        throw new Error(`Refus « ${code} » attendu, reçu ${got ? `« ${got} »` : (e as Error).message}`);
    }
    throw new Error(`Refus « ${code} » attendu : la commande a réussi`);
}

export async function waitFor<T>(
    probe: () => Promise<T | null | undefined | false>,
    signal: AbortSignal,
    {
        timeoutMs = 10_000,
        intervalMs = 250,
        what = 'la condition'
    }: { timeoutMs?: number; intervalMs?: number; what?: string } = {}
): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await probe();
        if (value !== null && value !== undefined && value !== false) return value;
        if (signal.aborted) throw new Error('Essai arrêté');
        if (Date.now() + intervalMs > deadline) throw new Error(`${what} : rien en ${Math.round(timeoutMs / 1000)} s`);
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
}

const moduleContexts = new WeakMap<E2eContext, SdkE2eContext>();

/** Ce qu'une étape de module reçoit : le contexte du SDK, bâti sur celui de l'essai et stable d'une étape à l'autre. */
function sdkContextOf(ctx: E2eContext, repo: unknown): SdkE2eContext {
    let sdk = moduleContexts.get(ctx);
    if (sdk) return sdk;
    const [account] = ctx.accounts;
    sdk = {
        account: {
            userId: account.userId,
            username: account.username,
            email: account.email,
            password: account.password,
            workspaceId: account.workspaceId
        },
        send: (command, input, opts) => account.client.send(command, input, opts),
        fetch: (path, init) => ctx.newClient().http(path, init),
        waitFor: (probe, opts) => waitFor(probe, ctx.signal, opts),
        defer: (label, undo) => ctx.ledger.defer(label, undo),
        state: ctx.state,
        repo,
        origins: ctx.deps.origins,
        signal: ctx.signal
    };
    moduleContexts.set(ctx, sdk);
    return sdk;
}

/** Un scénario déclaré par un module, avec un compte jetable ; ignoré quand le module est en maintenance. */
export function fromModule(featureId: string, label: string, scenario: SdkE2eScenario, repo: unknown): E2eScenario {
    return {
        id: `${featureId}.${scenario.id}`,
        label: scenario.label,
        sourceLabel: label,
        accounts: 1,
        skip: async (deps) =>
            maintenance.featureLevel(featureId)
                ? `« ${label} » est en maintenance`
                : ((await scenario.skip?.({ origins: deps.origins })) ?? null),
        steps: scenario.steps.map((step) => ({
            label: step.label,
            timeoutMs: step.timeoutMs,
            run: (ctx) => step.run(sdkContextOf(ctx, repo))
        }))
    };
}
