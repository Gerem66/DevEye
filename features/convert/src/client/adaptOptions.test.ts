import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { targetOf } from '../contracts/catalogue';
import { resolveOptions } from '../contracts/options';
import { adaptOptions } from './adaptOptions';

const NOTHING = { sourceQuality: null, sourceKbps: null };
const jpeg = (sourceQuality: number) => ({ ...NOTHING, sourceQuality });
const sound = (sourceKbps: number) => ({ ...NOTHING, sourceKbps });

const jpg = targetOf('image', 'jpg', 'jpg');
const mp3 = targetOf('audio', 'mp3', 'mp3');
const webp = targetOf('image', 'jpg', 'webp');

describe('réglages ajustés au fichier', () => {
    it('part sous la qualité d’un JPEG déjà compressé, et le dit', () => {
        assert.ok(jpg);
        const specs = adaptOptions(jpg, jpeg(78));
        assert.equal(resolveOptions(specs, {}).quality, 73);
        const quality = specs.find((s) => s.id === 'quality');
        assert.match(quality?.hint ?? '', /environ 78/);
        assert.equal(quality?.kind === 'slider' && quality.indicator, 78);
        assert.equal(resolveOptions(specs, { quality: 90 }).quality, 90, 'le choix reste libre');
    });

    it('marque la qualité d’origine sur la piste, sans toucher au défaut quand elle lui est supérieure', () => {
        assert.ok(jpg);
        const specs = adaptOptions(jpg, jpeg(95));
        const quality = specs.find((s) => s.id === 'quality');
        assert.ok(quality?.kind === 'slider');
        assert.equal(quality.indicator, 95);
        assert.equal(resolveOptions(specs, {}).quality, 82);
        assert.match(quality.hint ?? '', /environ 95/);
    });

    it('ne touche à rien quand la qualité d’origine est inconnue', () => {
        assert.ok(jpg);
        assert.equal(adaptOptions(jpg, NOTHING), jpg.options);
    });

    it('ne compare pas les qualités de deux formats', () => {
        assert.ok(webp);
        assert.equal(adaptOptions(webp, jpeg(60)), webp.options);
    });

    it('part du cran juste sous le débit d’un son, quel que soit son format', () => {
        assert.ok(mp3);
        const specs = adaptOptions(mp3, sound(130));
        const bitrate = specs.find((s) => s.id === 'bitrate');
        assert.ok(bitrate?.kind === 'slider');
        assert.equal(bitrate.indicator, 130);
        assert.equal(resolveOptions(specs, {}).bitrate, 128);
        assert.match(bitrate.hint ?? '', /130 kb\/s/);
    });

    it('ne marque rien quand le débit d’origine dépasse la piste (un WAV)', () => {
        assert.ok(mp3);
        assert.equal(adaptOptions(mp3, sound(1411)), mp3.options);
    });

    it('ne descend pas sous un plancher', () => {
        assert.ok(jpg);
        assert.equal(resolveOptions(adaptOptions(jpg, jpeg(20)), {}).quality, 40);
    });
});
