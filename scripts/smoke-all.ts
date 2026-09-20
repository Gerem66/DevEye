/**
 * `npm run ci:smoke` : le smoke E2E (`smoke-feature.ts`) de chaque module
 * installé, autonome : construit le client dans un dossier à lui, démarre un
 * serveur à lui, sonde chaque module, et éteint tout.
 *
 * Il lui faut une base MySQL joignable (variables DB_*) et un Chromium
 * (`SMOKE_BROWSER`, défaut chromium-browser).
 *
 * Isolé du dev qui tourne à côté : port SMOKE_PORT (défaut 3999), client
 * construit dans .smoke/client à la racine (jamais client/build, que le ci du
 * client reconstruit en parallèle), rate limit relevé pour que les connexions
 * enchaînées ne se bloquent pas entre elles.
 *
 * Les modules : ceux de features.config.json et de features.local.json.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { importManifest, readFeatureConfig, type FeatureConfigEntry } from './lib/features-config';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SMOKE_PORT ?? 3999);
const BASE_URL = `http://localhost:${PORT}`;
// Hors de client/ : un dossier de plus sous client/ tomberait sous son
// `eslint .` (des bundles minifiés à linter).
const SMOKE_DIR = path.join(ROOT, '.smoke');
const CLIENT_DIR = path.join(SMOKE_DIR, 'client');
const TSX = path.join(ROOT, 'node_modules', '.bin', 'tsx');

function fail(message: string): never {
    console.error(`\n✗ ci:smoke — ${message}`);
    process.exit(1);
}

/** L'identité d'un module installé (id + libellé), lue dans son manifest : même résolution que gen-features. */
async function moduleIdentity(entry: FeatureConfigEntry): Promise<{ id: string; label: string; accountOnly: boolean }> {
    const manifest = await importManifest(ROOT, entry);
    if (!manifest) fail(`${entry.package}: l'entrée racine n'exporte pas « manifest »`);
    return {
        id: manifest.id,
        label: manifest.accountEntry?.label ?? manifest.label,
        accountOnly: manifest.accountOnly === true
    };
}

function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): boolean {
    const res = spawnSync(cmd, args, { cwd: opts.cwd ?? ROOT, env: opts.env ?? process.env, stdio: 'inherit' });
    return res.status === 0;
}

/**
 * Ce que le serveur a journalisé, depuis l'octet `fromByte` : le tour d'un
 * module n'imprime alors que SES lignes. C'est le seul endroit où figure la
 * raison d'un refus, qu'un magasin client avale en silence, et le fichier part
 * avec le runner.
 */
function tailServerLog(logFile: string, fromByte = 0): void {
    let lines: string[] = [];
    try {
        lines = fs
            .readFileSync(logFile)
            .subarray(fromByte)
            .toString('utf8')
            .split('\n')
            .filter((l) => l.trim() !== '');
    } catch {
        return;
    }
    if (lines.length === 0) return;
    console.error('  journal du serveur:');
    for (const line of lines.slice(-30)) console.error(`    ${line}`);
}

async function waitForServer(server: ChildProcess, logFile: string): Promise<void> {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
        if (server.exitCode !== null) {
            tailServerLog(logFile);
            fail(
                `le serveur s'est arrêté avant d'être prêt (code ${server.exitCode}) — base joignable ? variables DB_* ?`
            );
        }
        try {
            const res = await fetch(`${BASE_URL}/`);
            if (res.ok) return;
        } catch {
            // pas encore à l'écoute
        }
        await new Promise((r) => setTimeout(r, 1000));
    }
    fail('le serveur ne répond pas après 90 s');
}

async function main(): Promise<void> {
    const entries = [
        ...readFeatureConfig(ROOT, 'features.config.json'),
        ...readFeatureConfig(ROOT, 'features.local.json')
    ];
    // `npm run ci:smoke -- devices mail` ne sonde que ces modules : le tour
    // complet reste la norme, ceci sert à rejouer un échec sans attendre les autres.
    const only = new Set(process.argv.slice(2).filter((a) => !a.startsWith('--')));
    const modules = [];
    for (const entry of entries) {
        const m = await moduleIdentity(entry);
        if (only.size === 0 || only.has(m.id)) modules.push(m);
    }
    if (modules.length === 0)
        fail(
            only.size > 0 ? `aucun module installé parmi : ${[...only].join(', ')}` : 'aucun module installé à sonder'
        );
    console.log(`ci:smoke — ${modules.length} module(s) : ${modules.map((m) => m.id).join(', ')}`);

    // La glue locale doit exister (le serveur l'importe statiquement) et le
    // client se construit dans SON dossier.
    if (!run('npm', ['run', 'gen:features:local'])) fail('gen:features:local a échoué');
    fs.mkdirSync(SMOKE_DIR, { recursive: true });
    if (!run('npm', ['--prefix', 'client', 'run', 'build', '--', '--outDir', CLIENT_DIR, '--emptyOutDir'])) {
        fail('la construction du client a échoué');
    }

    const logFile = path.join(SMOKE_DIR, 'server.log');
    const log = fs.openSync(logFile, 'w');
    const server = spawn(TSX, ['index.ts'], {
        cwd: ROOT,
        env: {
            ...process.env,
            SEED_DEV: 'true',
            LISTEN_PORT: String(PORT),
            PUBLIC_ORIGIN: BASE_URL,
            CLIENT_DIR,
            // Les smokes se connectent à la chaîne : le rate limit ordinaire
            // (200/min) les ferait se bloquer entre eux.
            RATE_LIMIT_MAX: '100000'
        },
        stdio: ['ignore', log, log]
    });
    const stopServer = (): void => {
        if (server.exitCode === null) server.kill('SIGTERM');
        setTimeout(() => {
            if (server.exitCode === null) server.kill('SIGKILL');
        }, 3000).unref();
    };
    process.on('exit', stopServer);

    await waitForServer(server, logFile);
    console.log(`serveur prêt sur ${BASE_URL} (journal : ${path.relative(ROOT, logFile)})\n`);

    const failed: string[] = [];
    for (const m of modules) {
        const from = fs.statSync(logFile).size;
        const ok = run(TSX, [
            path.join(ROOT, 'scripts', 'smoke-feature.ts'),
            m.id,
            m.label,
            `--url=${BASE_URL}`,
            ...(m.accountOnly ? ['--account'] : [])
        ]);
        if (!ok) {
            failed.push(m.id);
            tailServerLog(logFile, from);
        }
    }

    stopServer();
    if (failed.length > 0) fail(`${failed.length} module(s) en échec : ${failed.join(', ')}`);
    console.log(`\n✓ ci:smoke — ${modules.length}/${modules.length} module(s) sondés avec succès.`);
    process.exit(0);
}

void main();
