import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { targetOf } from '../contracts/catalogue';
import { resolveOptions } from '../contracts/options';
import { adaptOptions } from './adaptOptions';

const jpg = targetOf('image', 'jpg', 'jpg');
const webp = targetOf('image', 'jpg', 'webp');

describe('réglages ajustés au fichier', () => {
    it('part sous la qualité d’un JPEG déjà compressé, et le dit', () => {
        assert.ok(jpg);
        const specs = adaptOptions(jpg, 78);
        assert.equal(resolveOptions(specs, {}).quality, 73);
        assert.match(specs.find((s) => s.id === 'quality')?.hint ?? '', /environ 78/);
        assert.equal(resolveOptions(specs, { quality: 90 }).quality, 90, 'le choix reste libre');
    });

    it('ne touche à rien quand la source est meilleure que le défaut, ou inconnue', () => {
        assert.ok(jpg);
        assert.equal(adaptOptions(jpg, 95), jpg.options);
        assert.equal(adaptOptions(jpg, null), jpg.options);
    });

    it('ne compare pas les qualités de deux formats', () => {
        assert.ok(webp);
        assert.equal(adaptOptions(webp, 60), webp.options);
    });

    it('ne descend pas sous un plancher', () => {
        assert.ok(jpg);
        assert.equal(resolveOptions(adaptOptions(jpg, 20), {}).quality, 40);
    });
});
