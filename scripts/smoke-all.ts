/**
 * `npm run ci:smoke` — le smoke E2E de CHAQUE module installé, automatisé.
 *
 * Le smoke d'un module (`smoke-feature.ts`) garde la seule classe de bugs
 * qu'aucun autre contrôle ne voit (registre des commandes, catalogue, page
 * blanche) ; un garde qu'on lance « quand on y pense » n'en est pas un. Ce
 * script le rend autonome : il construit le client dans un dossier à lui,
 * démarre un serveur à lui, sonde chaque module, et éteint tout.
 *
 * Ce qu'il lui faut : une base MySQL joignable (variables DB_*, comme le
 * serveur — en local, le .env et le tunnel ; en CI, un service MySQL neuf,
 * que le boot migre de zéro) et un Chromium (`SMOKE_BROWSER`, défaut
 * chromium-browser).
 *
 * Isolé du dev qui tourne à côté : port SMOKE_PORT (défaut 3999, jamais 3000),
 * client construit dans .smoke/client à la racine (jamais client/build, que le
 * ci du client reconstruit en parallèle sous ./ci.sh — ni sous client/, dont
 * le lint ratisse tout), rate limit relevé pour que les connexions enchaînées
 * des smokes ne se bloquent pas entre elles.
 *
 * Les modules : ceux de features.config.json ET de features.local.json —
 * en local, les modules privés sont sondés aussi ; en CI, l'overlay local
 * n'existe pas.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { importManifest, readFeatureConfig, type FeatureConfigEntry } from './lib/features-config';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SMOKE_PORT ?? 3999);
const BASE_URL = `http://localhost:${PORT}`;
// Hors de client/ : un dossier de plus sous client/ tomberait sous son `eslint .`
// (des bundles minifiés à linter — le ci du client pendait indéfiniment).
const SMOKE_DIR = path.join(ROOT, '.smoke');
const CLIENT_DIR = path.join(SMOKE_DIR, 'client');
const TSX = path.join(ROOT, 'node_modules', '.bin', 'tsx');

function fail(message: string): never {
    console.error(`\n✗ ci:smoke — ${message}`);
    process.exit(1);
}

/** L'identité d'un module installé (id + libellé), lue dans son manifest : même résolution que gen-features. */
async function moduleIdentity(entry: FeatureConfigEntry): Promise<{ id: string; label: string }> {
    const manifest = await importManifest(ROOT, entry);
    if (!manifest) fail(`${entry.package}: l'entrée racine n'exporte pas « manifest »`);
    return { id: manifest.id, label: manifest.label };
}

function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): boolean {
    const res = spawnSync(cmd, args, { cwd: opts.cwd ?? ROOT, env: opts.env ?? process.env, stdio: 'inherit' });
    return res.status === 0;
}

async function waitForServer(server: ChildProcess, logFile: string): Promise<void> {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
        if (server.exitCode !== null) {
            console.error(fs.readFileSync(logFile, 'utf8').split('\n').slice(-40).join('\n'));
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
    const modules = [];
    for (const entry of entries) modules.push(await moduleIdentity(entry));
    if (modules.length === 0) fail('aucun module installé à sonder');
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
        const ok = run(TSX, [path.join(ROOT, 'scripts', 'smoke-feature.ts'), m.id, m.label, `--url=${BASE_URL}`]);
        if (!ok) failed.push(m.id);
    }

    stopServer();
    if (failed.length > 0) fail(`${failed.length} module(s) en échec : ${failed.join(', ')}`);
    console.log(`\n✓ ci:smoke — ${modules.length}/${modules.length} module(s) sondés avec succès.`);
    process.exit(0);
}

void main();
