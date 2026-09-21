import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { captureTool, ConvertCanceled, ConvertFailure, runTool } from './spawn';

/**
 * Le lanceur est la frontière entre le serveur et un outil tiers : ce qu'il
 * laisse passer, ce qu'il coupe, et pourquoi. `node` sert d'outil : il est
 * forcément là où ces tests tournent.
 */

let workDir: string;
before(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'convert-spawn-'));
});
after(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
});

const node = (script: string) => ({ bin: process.execPath, args: ['-e', script] });
const base = () => ({ workDir, signal: new AbortController().signal, timeoutMs: 20_000 });

describe('runTool', () => {
    it('ne transmet rien de l’environnement du serveur', async () => {
        process.env.CONVERT_TEST_SECRET = 'clé-du-serveur';
        try {
            const out = await captureTool(
                process.execPath,
                ['-e', 'console.log(JSON.stringify(process.env))'],
                workDir,
                20_000
            );
            const seen = JSON.parse(out) as Record<string, string>;
            assert.equal(seen.CONVERT_TEST_SECRET, undefined);
            assert.equal(seen.HOME, workDir);
            assert.equal(seen.TMPDIR, workDir);
        } finally {
            delete process.env.CONVERT_TEST_SECRET;
        }
    });

    it('ne passe par aucun shell : un argument reste un argument', async () => {
        const out = await captureTool(
            process.execPath,
            ['-e', 'console.log(process.argv[1])', '$(id); rm -rf /'],
            workDir,
            20_000
        );
        assert.equal(out.trim(), '$(id); rm -rf /');
    });

    it('rend les lignes au fil de l’eau', async () => {
        const lines: string[] = [];
        await runTool({ ...node('console.log("a=1"); console.log("b=2")'), ...base(), onLine: (l) => lines.push(l) });
        assert.deepEqual(lines, ['a=1', 'b=2']);
    });

    it('nomme l’outil qui manque', async () => {
        await assert.rejects(
            runTool({ bin: 'outil-qui-n-existe-pas', args: [], ...base() }),
            (e: unknown) =>
                e instanceof ConvertFailure && e.code === 'engine_missing' && /outil-qui-n-existe-pas/.test(e.message)
        );
    });

    it('rend la dernière ligne d’erreur de l’outil', async () => {
        await assert.rejects(
            runTool({ ...node('console.error("fichier illisible"); process.exit(3)'), ...base() }),
            (e: unknown) =>
                e instanceof ConvertFailure && e.code === 'engine_failed' && /fichier illisible/.test(e.message)
        );
    });

    it('tue au dépassement du budget de temps', async () => {
        await assert.rejects(
            runTool({ ...node('setInterval(() => console.log("."), 200)'), ...base(), timeoutMs: 500 }),
            (e: unknown) => e instanceof ConvertFailure && e.code === 'timeout'
        );
    });

    it('tue un outil qui ne dit et n’écrit plus rien', async () => {
        await assert.rejects(
            runTool({ ...node('setInterval(() => {}, 1000)'), ...base(), stallMs: 500 }),
            (e: unknown) => e instanceof ConvertFailure && e.code === 'stalled'
        );
    });

    it('tue quand le fichier produit dépasse son plafond', async () => {
        const out = path.join(workDir, 'gros.bin');
        const script = `const fs=require('fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(out)},Buffer.alloc(200000)),100)`;
        await assert.rejects(
            runTool({ ...node(script), ...base(), watchFile: out, maxOutputBytes: 300_000 }),
            (e: unknown) => e instanceof ConvertFailure && e.code === 'output_too_large'
        );
    });

    it('s’arrête sur annulation, sans en faire un échec', async () => {
        const controller = new AbortController();
        const running = runTool({
            ...node('setInterval(() => console.log("."), 200)'),
            ...base(),
            signal: controller.signal
        });
        setTimeout(() => controller.abort(), 300);
        await assert.rejects(running, (e: unknown) => e instanceof ConvertCanceled);
    });
});
