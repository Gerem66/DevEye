import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { isSafeOrigin, readInstaller, renderInstaller } from './installers';

describe('renderInstaller', () => {
    it("pose l'origine partout, sans barre finale, et nulle part ailleurs", () => {
        const out = renderInstaller("a='__DEVEYE_SERVER__' b=__DEVEYE_SERVER__/x", 'https://app.deveye.fr/');
        assert.equal(out, "a='https://app.deveye.fr' b=https://app.deveye.fr/x");
    });

    it('accepte un port, une IPv6 et un chemin', () => {
        for (const origin of ['http://localhost:3000', 'https://[::1]:8443', 'https://box.lan/deveye']) {
            assert.ok(isSafeOrigin(origin), origin);
        }
    });

    it("refuse ce qu'un script ne saurait porter entre apostrophes", () => {
        for (const origin of [
            "https://x.test/'; rm -rf ~; '",
            'https://x.test/$(id)',
            'https://x.test/`id`',
            'https://x.test/a b',
            'javascript:alert(1)',
            'https://user@x.test',
            'ftp://x.test'
        ]) {
            assert.equal(renderInstaller('__DEVEYE_SERVER__', origin), null, origin);
        }
    });

    it('rend un install.sh que le shell sait lire', () => {
        const script = renderInstaller(readInstaller('sh'), 'https://app.deveye.fr');
        assert.ok(script && !script.includes('__DEVEYE_SERVER__'));
        const dir = mkdtempSync(join(tmpdir(), 'deveye-installer-'));
        try {
            const file = join(dir, 'install.sh');
            writeFileSync(file, script);
            execFileSync('sh', ['-n', file]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('rend un install.ps1 sans reste du gabarit', () => {
        const script = renderInstaller(readInstaller('ps1'), 'https://app.deveye.fr');
        assert.ok(script?.includes("$server = 'https://app.deveye.fr'"));
    });
});
