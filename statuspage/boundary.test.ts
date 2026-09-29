import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { build } from 'esbuild';

/**
 * La page d'état tourne sans l'env de DevEye : un import de `Utils/Env`, de la
 * base ou des modules, même indirect, la ferait planter au démarrage de son
 * conteneur. Le bundle réel dit ce qui y entre.
 */
const ALLOWED_PACKAGES = new Set(['zod', 'nodemailer', 'dotenv', 'dotenv-oxy']);
const FORBIDDEN =
    /^src\/(Utils\/|db\/|features\/|auth\/|ws\/|logger|Services\/(?!alertCore\.ts$|mailer\.ts$|statusProbeContract\.ts$|notices\/shared\.ts$))/;

describe('frontière de la page d’état', () => {
    it('le bundle n’embarque rien de l’app au-delà des fichiers purs', async () => {
        const result = await build({
            entryPoints: ['statuspage/index.ts'],
            bundle: true,
            platform: 'node',
            format: 'esm',
            write: false,
            metafile: true,
            logLevel: 'silent'
        });
        const inputs = Object.keys(result.metafile.inputs);
        const packages = new Set(
            inputs.filter((p) => p.includes('node_modules/')).map((p) => p.split('node_modules/').pop()!.split('/')[0]!)
        );
        assert.deepEqual(
            [...packages].filter((p) => !ALLOWED_PACKAGES.has(p)),
            []
        );
        assert.deepEqual(
            inputs.filter((p) => !p.includes('node_modules/') && FORBIDDEN.test(p)),
            []
        );
    });
});
