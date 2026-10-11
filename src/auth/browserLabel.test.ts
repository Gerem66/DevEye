import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { browserLabel } from './browserLabel';

describe('browserLabel', () => {
    it('nomme le navigateur et son système', () => {
        assert.equal(
            browserLabel('Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0'),
            'Firefox sur Linux'
        );
        assert.equal(
            browserLabel(
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0'
            ),
            'Edge sur Windows'
        );
        assert.equal(
            browserLabel(
                'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
            ),
            'Safari sur iOS'
        );
        assert.equal(
            browserLabel(
                'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36'
            ),
            'Chrome sur Android'
        );
        assert.equal(
            browserLabel(
                'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.0.0 Safari/537.36'
            ),
            'Chrome sur Linux'
        );
    });

    it('dit ce qu’il sait, et rien quand il ne sait rien', () => {
        assert.equal(browserLabel('curl/8.0'), 'Navigateur inconnu');
        assert.equal(browserLabel(undefined), 'Navigateur inconnu');
    });
});
