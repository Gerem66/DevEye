/**
 * `npm run ci:smoke` : le smoke E2E (`smoke-feature.ts`) de chaque module
 * installé, puis les parcours de la page « Tests et débogage »
 * (`e2e-all.ts`), sur un même serveur. Autonome : construit le client dans un
 * dossier à lui, démarre un serveur à lui, et éteint tout.
 *
 * Il lui faut une base MySQL joignable (variables DB_*) et un Chromium
 * (`SMOKE_BROWSER`, défaut chromium-browser).
 *
 * Isolé du dev qui tourne à côté : port SMOKE_PORT (défaut 3999), client
 * construit dans .smoke/client à la racine (jamais client/build, que le ci du
 * client reconstruit en parallèle).
 *
 * Les modules : ceux de features.config.json et de features.local.json.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { importManifest, readFeatureConfig, type FeatureConfigEntry } from './lib/features-config';
import { startTestServer } from './lib/test-server';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SMOKE_PORT ?? 3999);
// Hors de client/ : un dossier de plus sous client/ tomberait sous son
// `eslint .` (des bundles minifiés à linter).
const SMOKE_DIR = path.join(ROOT, '.smoke');
const CLIENT_DIR = path.join(SMOKE_DIR, 'client');
const TSX = path.join(ROOT, 'node_modules', '.bin', 'tsx');

function fail(message: string): never {
    console.error(`\n✗ ci:smoke : ${message}`);
    process.exit(1);
}

/**
 * L'identité d'un module installé (id + libellé), lue dans son manifest : même
 * résolution que gen-features. `moderationTab` : un module de compte sans
 * entrée de menu ne vit que dans la popup « Modération », par ses onglets.
 */
async function moduleIdentity(
    entry: FeatureConfigEntry
): Promise<{ id: string; label: string; accountOnly: boolean; moderationTab: string | null }> {
    const manifest = await importManifest(ROOT, entry);
    if (!manifest) fail(`${entry.package}: l'entrée racine n'exporte pas « manifest »`);
    const popupOnly = manifest.accountOnly === true && !manifest.accountEntry;
    return {
        id: manifest.id,
        label: manifest.accountEntry?.label ?? manifest.label,
        accountOnly: manifest.accountOnly === true && !popupOnly,
        moderationTab: popupOnly ? (manifest.adminTabs?.[0]?.label ?? null) : null
    };
}

function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): boolean {
    const res = spawnSync(cmd, args, { cwd: opts.cwd ?? ROOT, env: opts.env ?? process.env, stdio: 'inherit' });
    return res.status === 0;
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
    console.log(`ci:smoke : ${modules.length} module(s) : ${modules.map((m) => m.id).join(', ')}`);

    // La glue locale doit exister (le serveur l'importe statiquement) et le
    // client se construit dans SON dossier.
    if (!run('npm', ['run', 'gen:features:local'])) fail('gen:features:local a échoué');
    fs.mkdirSync(SMOKE_DIR, { recursive: true });
    if (!run('npm', ['--prefix', 'client', 'run', 'build', '--', '--outDir', CLIENT_DIR, '--emptyOutDir'])) {
        fail('la construction du client a échoué');
    }

    const server = await startTestServer({ root: ROOT, port: PORT, clientDir: CLIENT_DIR }).catch((e: Error) =>
        fail(e.message)
    );
    console.log(`serveur prêt sur ${server.baseUrl} (journal : ${path.relative(ROOT, server.logFile)})\n`);

    // Toutes les migrations viennent de passer : chaque table doit avoir un
    // sort dans l'export des données d'un compte, que le boot ne fait que signaler.
    if (only.size === 0 && !run(TSX, [path.join(ROOT, 'scripts', 'export-coverage.ts')])) {
        server.stop();
        fail('des tables n’ont aucun sort dans l’export des données (Docs/ACCOUNT_EXPORT.md)');
    }

    const failed: string[] = [];
    for (const m of modules) {
        const from = server.logSize();
        const ok = run(TSX, [
            path.join(ROOT, 'scripts', 'smoke-feature.ts'),
            m.id,
            m.label,
            `--url=${server.baseUrl}`,
            ...(m.accountOnly ? ['--account'] : []),
            ...(m.moderationTab !== null ? [`--moderation=${m.moderationTab}`] : [])
        ]);
        if (!ok) {
            failed.push(m.id);
            server.tailLog(from);
        }
    }

    // Un tour restreint à quelques modules ne rejoue pas les parcours :
    // `npm run e2e` les lance seuls.
    let journeys = true;
    if (only.size === 0) {
        console.log('');
        const from = server.logSize();
        journeys = run(TSX, [path.join(ROOT, 'scripts', 'e2e-all.ts'), `--url=${server.baseUrl}`, '--open-signups']);
        if (!journeys) server.tailLog(from);
    }

    server.stop();
    if (failed.length > 0) fail(`${failed.length} module(s) en échec : ${failed.join(', ')}`);
    if (!journeys) fail('des parcours de bout en bout sont en échec');
    console.log(`\n✓ ci:smoke : ${modules.length}/${modules.length} module(s) sondés avec succès.`);
    process.exit(0);
}

void main();
