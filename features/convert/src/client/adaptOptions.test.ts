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
        const quality = specs.find((s) => s.id === 'quality');
        assert.match(quality?.hint ?? '', /environ 78/);
        assert.equal(quality?.kind === 'slider' && quality.indicator, 78);
        assert.equal(resolveOptions(specs, { quality: 90 }).quality, 90, 'le choix reste libre');
    });

    it('marque la qualité d’origine sur la piste, sans toucher au défaut quand elle lui est supérieure', () => {
        assert.ok(jpg);
        const specs = adaptOptions(jpg, 95);
        const quality = specs.find((s) => s.id === 'quality');
        assert.ok(quality?.kind === 'slider');
        assert.equal(quality.indicator, 95);
        assert.equal(resolveOptions(specs, {}).quality, 82);
        assert.match(quality.hint ?? '', /environ 95/);
    });

    it('ne touche à rien quand la qualité d’origine est inconnue', () => {
        assert.ok(jpg);
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
