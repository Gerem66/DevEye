import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defineModuleEnv } from '@deveye/types/sdk/server';

import { unsetEnvReport } from './register';

const SPEC = defineModuleEnv({
    X_SITE_URL: { kind: 'url', default: 'https://deveye.fr' },
    X_TICK_SECONDS: { kind: 'int', default: 60 },
    X_SECRET: { kind: 'secret' },
    X_CLIENT_ID: { kind: 'text', default: '', optional: true }
});

describe('unsetEnvReport', () => {
    it('nomme chaque variable laissée à son défaut, avec la valeur appliquée', () => {
        assert.equal(
            unsetEnvReport(SPEC, { X_TICK_SECONDS: 'dix' }),
            'X_SITE_URL=https://deveye.fr (non définie), X_TICK_SECONDS=60 (valeur invalide ignorée), X_SECRET=(vide) (non définie)'
        );
    });

    it('se tait quand tout est posé, un vide explicite compris', () => {
        assert.equal(unsetEnvReport(SPEC, { X_SITE_URL: '', X_TICK_SECONDS: '30', X_SECRET: 's3cr3t' }), null);
    });

    it("n'écrit jamais la valeur d'un secret", () => {
        const report = unsetEnvReport(SPEC, { X_SECRET: 's3cr3t' }) ?? '';
        assert.ok(!report.includes('s3cr3t'));
    });
});
