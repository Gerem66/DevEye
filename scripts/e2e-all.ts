/**
 * `npm run e2e` : les parcours de la page « Tests et débogage », lancés sans
 * navigateur par le compte de développement semé, puis jugés
 * (`lib/e2e-report.ts`).
 *
 * Sans `--url`, démarre un serveur à lui (l'API seule : aucun client à
 * construire) et l'éteint. `ci:smoke` le rappelle avec `--url`, sur le sien.
 *
 * Usage :
 *   npm run e2e                        tous ceux qui ne dépendent que de ce serveur
 *   npm run e2e -- notes.lifecycle     ceux qu'on nomme, tels quels
 *   npm run e2e -- --external          aussi ceux qui dépendent d'un tiers
 *
 * Sur son propre serveur, il ouvre d'abord les inscriptions, fermées dès qu'un
 * compte existe : le cycle de vie d'un compte s'ignorerait sinon. Le réglage
 * est rangé par origine, il ne touche donc que ce serveur d'essai. Avec
 * `--url`, il faut le demander : `--open-signups`.
 *
 * Env : E2E_EXPECTED_SKIPS (identifiants séparés par des virgules : les
 *       parcours qui ont le droit de se dire ignorés ici), SMOKE_USERNAME /
 *       SMOKE_PASSWORD (défaut : le compte semé), SMOKE_PORT (défaut 3999).
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CommandOutput, DebugRun } from '@deveye/types';

import { createTestClient, type TestClient } from '@/Services/debug/e2e/client';
import { batchesOf, e2eVerdict, parseSkips, scenarioLine, selectScenarios, staleSkips } from './lib/e2e-report';
import { startTestServer, type TestServer } from './lib/test-server';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USERNAME = process.env.SMOKE_USERNAME ?? 'dev';
const PASSWORD = process.env.SMOKE_PASSWORD ?? 'devdevdev';
/** Au-delà du temps que le serveur laisse à ses parcours : le ménage, puis c'est l'essai qui ne répond plus. */
const RUN_MARGIN_MS = 60_000;

const args = process.argv.slice(2);
const only = args.filter((a) => !a.startsWith('--'));
const url = args.find((a) => a.startsWith('--url='))?.slice('--url='.length);
const external = args.includes('--external');
const openSignups = !url || args.includes('--open-signups');

let server: TestServer | null = null;
let client: TestClient | null = null;

function finish(code: number): never {
    client?.close();
    server?.stop();
    process.exit(code);
}

function fail(message: string): never {
    console.error(`\n✗ e2e : ${message}`);
    finish(1);
}

async function signIn(base: string): Promise<TestClient> {
    const browser = createTestClient({
        base,
        host: new URL(base).host,
        // Le jeton d'aucun essai : ces requêtes restent celles d'un navigateur ordinaire.
        runToken: 'e2e-all',
        signal: new AbortController().signal
    });
    const login = await browser.api<{ status: string; step?: string }>('/api/auth/login', {
        username: USERNAME,
        password: PASSWORD
    });
    if (login.status !== 'signedIn') {
        fail(
            `le compte « ${USERNAME} » doit encore franchir l'étape « ${login.step ?? '?'} » : il faut le compte que SEED_DEV crée, sans confirmation de connexion`
        );
    }
    await browser.connect();
    return browser;
}

/** Suit un essai jusqu'à sa fin, en imprimant chaque parcours dès qu'il a son sort. */
async function follow(browser: TestClient, runId: number, budgetMs: number): Promise<DebugRun> {
    const printed = new Set<string>();
    const deadline = Date.now() + budgetMs + RUN_MARGIN_MS;
    for (;;) {
        const run = await browser.send<DebugRun>('debug.runGet', { runId });
        if (run.report.kind === 'e2e') {
            for (const scenario of run.report.scenarios) {
                if (printed.has(scenario.id) || scenario.status === 'pending' || scenario.status === 'running')
                    continue;
                printed.add(scenario.id);
                console.log(`  ${scenarioLine(scenario)}`);
            }
        }
        if (run.status !== 'running') return run;
        if (Date.now() > deadline) {
            await browser.send('debug.runAbort', { runId }).catch(() => undefined);
            fail(`l'essai ${runId} ne se termine pas`);
        }
        await new Promise((r) => setTimeout(r, 1000));
    }
}

async function main(): Promise<void> {
    let base = url;
    let logFrom = 0;
    if (!base) {
        // Le serveur importe la glue des modules installés.
        if (spawnSync('npm', ['run', 'gen:features:local'], { cwd: ROOT, stdio: 'inherit' }).status !== 0) {
            fail('gen:features:local a échoué');
        }
        server = await startTestServer({ root: ROOT, port: Number(process.env.SMOKE_PORT ?? 3999) });
        base = server.baseUrl;
        logFrom = server.logSize();
    }
    client = await signIn(base);
    if (openSignups) await client.send('admin.maintenanceSignups', { open: true });

    const catalog = await client.send<CommandOutput<'debug.e2eCatalog'>>('debug.e2eCatalog', {});
    if (catalog.blocked) fail(catalog.blocked);
    const expectedSkips = parseSkips(process.env.E2E_EXPECTED_SKIPS);
    const picked = selectScenarios(catalog.scenarios, { only, external });
    if (picked.unknown.length > 0) fail(`parcours inconnu : ${picked.unknown.join(', ')}`);
    if (picked.ids.length === 0) fail('aucun parcours à lancer');

    console.log(`e2e : ${picked.ids.length} parcours`);
    if (picked.external.length > 0) {
        const names = picked.external.map((s) => `${s.id} (${s.external})`).join(', ');
        console.log(`  laissés de côté, ils dépendent d'un tiers (--external les lance) : ${names}`);
    }

    const budgets = new Map(catalog.scenarios.map((s) => [s.id, s.budgetMs]));
    const runs: DebugRun[] = [];
    for (const batch of batchesOf(picked.ids)) {
        const { runId } = await client.send<{ runId: number }>('debug.e2eStart', { scenarios: batch });
        runs.push(
            await follow(
                client,
                runId,
                batch.reduce((ms, id) => ms + (budgets.get(id) ?? 0), 0)
            )
        );
    }

    const { problems } = e2eVerdict(runs, expectedSkips);
    // Sur un tour complet seulement : un tour nommé ne voit pas tout le catalogue.
    if (only.length === 0) {
        for (const id of staleSkips(catalog.scenarios, expectedSkips)) {
            problems.push(`E2E_EXPECTED_SKIPS nomme « ${id} », que ce serveur ne connaît pas`);
        }
    }
    if (problems.length > 0) {
        console.error(`\n✗ e2e : ${problems.length} problème(s)`);
        for (const problem of problems) console.error(`  ${problem}`);
        server?.tailLog(logFrom);
        finish(1);
    }
    const scenarios = runs.flatMap((r) => (r.report.kind === 'e2e' ? r.report.scenarios : []));
    const skipped = scenarios.filter((s) => s.status === 'skipped').length;
    const passed = scenarios.length - skipped;
    console.log(
        `\n✓ e2e : ${passed} parcours ${passed > 1 ? 'réussis' : 'réussi'}` +
            (skipped > 0 ? `, ${skipped} ignoré(s) comme attendu` : '') +
            ', aucun compte d’essai restant.'
    );
    finish(0);
}

main().catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
