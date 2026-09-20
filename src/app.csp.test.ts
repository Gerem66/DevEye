import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CONTENT_SECURITY_POLICY, documentCsp } from './app';

const directive = (csp: string, name: string): string[] =>
    csp
        .split(';')
        .find((d) => d.startsWith(`${name} `))!
        .split(' ')
        .slice(1);

describe('documentCsp', () => {
    it('n’élargit que connect-src, vers l’instance et sa socket', () => {
        const csp = documentCsp(['https://a.example', 'http://10.0.0.4:3000']);
        assert.deepEqual(directive(csp, 'connect-src'), [
            ...CONTENT_SECURITY_POLICY.directives['connect-src'],
            'https://a.example',
            'wss://a.example',
            'http://10.0.0.4:3000',
            'ws://10.0.0.4:3000'
        ]);
        assert.deepEqual(directive(csp, 'script-src'), ["'self'"]);
        assert.deepEqual(directive(csp, 'frame-ancestors'), ["'none'"]);
    });

    it('porte toutes les directives de la politique commune', () => {
        const names = documentCsp([])
            .split(';')
            .map((d) => d.split(' ')[0]);
        assert.deepEqual(names, Object.keys(CONTENT_SECURITY_POLICY.directives));
    });
});
