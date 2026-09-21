import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CATALOGUE, detectSource, outputName, targetOf, targetsFor } from './catalogue';
import { estimateSize, minTargetBytes, minVideoBitrate, videoBitrateForTarget, type MediaInfo } from './estimate';
import { cropRect, fitInside, imageDims, keptSeconds, resizeDims, scaleOf, sizeAtScale, videoDims } from './geometry';
import { isActive, isDefault, resolveOptions, type OptionValues, type SizeValue } from './options';
import { convertCurrency, convertUnit, UNIT_CATEGORIES } from './units';

/**
 * Le catalogue est la seule source de vérité des formats : ces tests tiennent
 * ce qu'aucun typage ne garantit d'une entrée ajoutée à la main.
 */

const VIDEO: MediaInfo = { bytes: 50_000_000, durationMs: 60_000, width: 1920, height: 1080, fps: 30 };

describe('catalogue', () => {
    it('ne porte aucun identifiant en double, ni réglage en double dans une cible', () => {
        for (const kind of CATALOGUE) {
            const sources = kind.sources.map((s) => s.id);
            const targets = kind.targets.map((t) => t.id);
            assert.equal(new Set(sources).size, sources.length, `sources de ${kind.id}`);
            assert.equal(new Set(targets).size, targets.length, `cibles de ${kind.id}`);
            for (const target of kind.targets) {
                const ids = target.options.map((o) => o.id);
                assert.equal(new Set(ids).size, ids.length, `réglages de ${kind.id}/${target.id}`);
            }
        }
    });

    it('ne conditionne un réglage qu’à un réglage qui existe, et qui peut prendre cette valeur', () => {
        for (const kind of CATALOGUE) {
            for (const target of kind.targets) {
                for (const option of target.options) {
                    if (!option.when) continue;
                    const parent = target.options.find((o) => o.id === option.when?.option);
                    assert.ok(parent, `${target.id}.${option.id} dépend d’un réglage absent`);
                    if (parent.kind === 'segments') {
                        assert.ok(parent.options.some((o) => o.value === option.when?.equals));
                    }
                }
            }
        }
    });

    it('donne à chaque source au moins une cible, et à chaque cible au moins une source', () => {
        for (const kind of CATALOGUE) {
            for (const source of kind.sources) assert.ok(targetsFor(kind.id, source.id).length > 0, source.id);
            const groups = new Set(kind.sources.map((s) => s.group));
            for (const target of kind.targets)
                assert.ok(
                    target.from.some((g) => groups.has(g)),
                    target.id
                );
        }
    });

    it('exige un lecteur pour tout format que ffmpeg ou ImageMagick lit', () => {
        for (const kind of CATALOGUE) {
            if (kind.id === 'document') continue;
            for (const source of kind.sources) assert.ok(source.readers?.length, `${kind.id}/${source.id}`);
        }
    });

    it('écarte les paires qui n’ont pas de sens', () => {
        assert.equal(targetOf('document', 'xlsx', 'docx'), null);
        assert.equal(targetOf('document', 'pdf', 'pdf'), null);
        assert.ok(targetOf('document', 'pdf', 'pdf-light'));
        assert.ok(targetOf('video', 'mp4', 'mp4'), 'même format : compresser');
    });

    it('reconnaît un fichier à son extension, quelle que soit la casse', () => {
        assert.deepEqual(detectSource('Vacances.MOV')?.source.id, 'mov');
        assert.deepEqual(detectSource('photo.jpeg')?.kind, 'image');
        assert.equal(detectSource('sans-extension'), null);
        assert.equal(detectSource('archive.zip'), null);
    });

    it('nomme le résultat d’après l’original', () => {
        const target = targetOf('video', 'mov', 'webm');
        assert.ok(target);
        assert.equal(outputName('mon film.final.mov', target), 'mon film.final.webm');
        assert.equal(outputName('.mov', target), '.mov.webm');
    });
});

describe('réglages', () => {
    const specs = targetOf('video', 'mp4', 'mp4')?.options ?? [];

    it('complète par les défauts et borne ce qui sort des limites', () => {
        const values = resolveOptions(specs, { quality: 400, height: 'inconnue', audio: 'oui' });
        assert.equal(values.quality, 100);
        assert.equal(values.height, 'source');
        assert.equal(values.audio, true);
        assert.equal(values.mode, 'quality');
    });

    it('oublie ce qui n’est pas déclaré', () => {
        assert.equal('intrus' in resolveOptions(specs, { intrus: 'rm -rf' }), false);
    });

    it('remet à son défaut un réglage que son `when` masque', () => {
        const values = resolveOptions(specs, { mode: 'quality', targetBytes: 1234 });
        assert.equal(values.targetBytes, 25 * 1024 * 1024);
        const spec = specs.find((o) => o.id === 'targetBytes');
        assert.ok(spec);
        assert.equal(isActive(spec, values), false);
    });

    it('sait dire qu’un réglage n’a pas bougé, quel que soit l’ordre de ses champs', () => {
        const image = targetOf('image', 'png', 'jpg')?.options ?? [];
        const resize = image.find((o) => o.id === 'resize');
        const crop = image.find((o) => o.id === 'crop');
        assert.ok(resize && crop);
        assert.equal(isDefault(resize, { keepRatio: true, height: null, width: null }), true);
        assert.equal(isDefault(resize, { width: 800, height: null, keepRatio: true }), false);
        assert.equal(isDefault(resize, { width: null, height: null, keepRatio: false }), false);
        assert.equal(isDefault(crop, null), true);
        assert.equal(isDefault(crop, { top: 0, right: 10, bottom: 0, left: 0 }), false);
        assert.equal(isDefault(crop, undefined), true);
    });

    it('refuse un recadrage mal formé', () => {
        assert.equal(resolveOptions(specs, { crop: { top: -1, right: 0, bottom: 0, left: 0 } }).crop, null);
        const rectangle = { crop: { x: 0, y: 0, width: 10, height: 10 } } as unknown as OptionValues;
        assert.equal(resolveOptions(specs, rectangle).crop, null, 'un rectangle n’est pas des marges');
    });
});

describe('géométrie', () => {
    const SOURCE = { width: 100, height: 80 };

    it('tire des marges la zone gardée, et rien quand elles ne retirent rien', () => {
        assert.deepEqual(cropRect(SOURCE, { top: 10, right: 20, bottom: 30, left: 5 }), {
            x: 5,
            y: 10,
            width: 75,
            height: 40
        });
        assert.equal(cropRect(SOURCE, { top: 0, right: 0, bottom: 0, left: 0 }), null);
        assert.equal(cropRect(SOURCE, null), null);
    });

    it('laisse toujours deux pixels, quelles que soient les marges', () => {
        assert.deepEqual(cropRect(SOURCE, { top: 0, right: 500, bottom: 0, left: 90 }), {
            x: 90,
            y: 0,
            width: 2,
            height: 80
        });
        assert.deepEqual(cropRect(SOURCE, { top: 999, right: 0, bottom: 999, left: 0 })?.height, 2);
    });

    it('garde les proportions dans un cadre, ou étire aux dimensions exactes', () => {
        const source = { width: 800, height: 600 };
        assert.deepEqual(resizeDims(source, { width: 400, height: null, keepRatio: true }), {
            width: 400,
            height: 300
        });
        assert.deepEqual(resizeDims(source, { width: 400, height: 400, keepRatio: true }), { width: 400, height: 300 });
        assert.deepEqual(resizeDims(source, { width: 400, height: 400, keepRatio: false }), {
            width: 400,
            height: 400
        });
        assert.deepEqual(resizeDims(source, { width: null, height: 100, keepRatio: false }), {
            width: 800,
            height: 100
        });
        assert.deepEqual(resizeDims(source, { width: 1600, height: null, keepRatio: true }), {
            width: 1600,
            height: 1200
        });
        assert.deepEqual(resizeDims(source, { width: null, height: null, keepRatio: false }), source);
    });

    it('garde l’échelle d’un redimensionnement quand la zone recadrée change, sans dérive', () => {
        const half = { width: 2000, height: 1500, keepRatio: true };
        const scale = scaleOf(half, { width: 4000, height: 3000 });
        assert.deepEqual(scale, { x: 0.5, y: 0.5 });
        assert.deepEqual(sizeAtScale(half, scale, { width: 3000, height: 3000 }), { ...half, width: 1500 });
        // Mille petits gestes, puis retour à la zone de départ : exactement les dimensions de départ.
        let size: SizeValue = half;
        for (let width = 3999; width > 3000; width--) size = sizeAtScale(size, scale, { width, height: 3000 });
        assert.deepEqual(sizeAtScale(size, scale, { width: 4000, height: 3000 }), half);
    });

    it('rend « inchangé » quand les dimensions retombent sur la zone', () => {
        const full = { width: 4000, height: 3000, keepRatio: true };
        const scale = scaleOf(full, { width: 4000, height: 3000 });
        assert.deepEqual(sizeAtScale(full, scale, { width: 2000, height: 1000 }), {
            width: null,
            height: null,
            keepRatio: true
        });
    });

    it('recadre avant de redimensionner', () => {
        assert.deepEqual(
            imageDims(
                { width: 800, height: 600 },
                { top: 0, right: 200, bottom: 0, left: 0 },
                { width: 300, height: null, keepRatio: true }
            ),
            { width: 300, height: 300 }
        );
    });

    it('n’agrandit jamais une vidéo, et lui rend des dimensions paires', () => {
        assert.deepEqual(fitInside({ width: 800, height: 600 }, { width: 4000, height: null }), {
            width: 800,
            height: 600
        });
        const dims = videoDims({ width: 1921, height: 1081 }, null, 721);
        assert.equal(dims.width % 2, 0);
        assert.equal(dims.height % 2, 0);
    });

    it('découpe un passage', () => {
        assert.equal(keptSeconds(60_000, 10, 25), 15);
        assert.equal(keptSeconds(60_000, null, null), 60);
        assert.equal(keptSeconds(60_000, 50, 20), 10, 'une fin avant le début est ignorée');
    });
});

describe('estimation', () => {
    const mp4 = targetOf('video', 'mp4', 'mp4');
    const mp3 = targetOf('audio', 'wav', 'mp3');
    const options = (over: OptionValues): OptionValues => resolveOptions(mp4?.options ?? [], over);

    it('est exacte quand une taille est visée', () => {
        assert.ok(mp4);
        assert.deepEqual(estimateSize(mp4, options({ mode: 'size', targetBytes: 8_000_000 }), VIDEO), {
            bytes: 8_000_000,
            exact: true
        });
    });

    it('croît avec la qualité, et se dit approchée', () => {
        assert.ok(mp4);
        const low = estimateSize(mp4, options({ quality: 10 }), VIDEO);
        const high = estimateSize(mp4, options({ quality: 90 }), VIDEO);
        assert.ok(low && high && high.bytes > low.bytes * 3);
        assert.equal(low.exact, false);
    });

    it('calcule un fichier audio au débit près', () => {
        assert.ok(mp3);
        const estimate = estimateSize(mp3, resolveOptions(mp3.options, { bitrate: 192 }), {
            ...VIDEO,
            width: null,
            height: null
        });
        assert.ok(estimate?.exact);
        assert.ok(Math.abs(estimate.bytes - (192_000 * 60) / 8) < 5000);
    });

    it('ne dit rien quand elle ne sait pas', () => {
        const pdf = targetOf('document', 'docx', 'pdf');
        assert.ok(pdf);
        assert.equal(estimateSize(pdf, {}, VIDEO), null);
        assert.ok(mp4);
        assert.equal(estimateSize(mp4, options({}), { ...VIDEO, durationMs: null }), null);
    });

    it('tire d’une taille le débit vidéo qui la remplit', () => {
        const bitrate = videoBitrateForTarget(10_000_000, 60, 128_000, 0.015);
        const total = ((bitrate + 128_000) * 60 * 1.015) / 8;
        assert.ok(Math.abs(total - 10_000_000) < 100);
        assert.ok(videoBitrateForTarget(100_000, 600, 128_000, 0.015) < 0, 'le son seul dépasse');
    });

    it('donne le plancher qu’un refus doit citer', () => {
        const floor = minTargetBytes(1920, 1080, 60, 128_000, 0.015);
        assert.ok(videoBitrateForTarget(floor, 60, 128_000, 0.015) >= minVideoBitrate(1920, 1080) - 1);
    });
});

describe('unités et devises', () => {
    it('fait l’aller-retour de chaque unité sans dérive', () => {
        for (const category of UNIT_CATEGORIES) {
            const base = category.units[0].id;
            for (const unit of category.units) {
                const there = convertUnit(category, base, unit.id, 12.5);
                assert.ok(there !== null);
                const back = convertUnit(category, unit.id, base, there);
                assert.ok(back !== null && Math.abs(back - 12.5) < 1e-9, `${category.id}/${unit.id}`);
            }
        }
    });

    it('sait que l’eau gèle à 32 °F et bout à 212', () => {
        const temperature = UNIT_CATEGORIES.find((c) => c.id === 'temperature');
        assert.ok(temperature);
        assert.ok(Math.abs((convertUnit(temperature, 'c', 'f', 0) ?? 0) - 32) < 1e-9);
        assert.ok(Math.abs((convertUnit(temperature, 'c', 'f', 100) ?? 0) - 212) < 1e-9);
        assert.ok(Math.abs((convertUnit(temperature, 'k', 'c', 0) ?? 0) + 273.15) < 1e-9);
    });

    it('croise deux devises par leur taux contre l’euro', () => {
        const rates = { EUR: 1, USD: 1.2, GBP: 0.8 };
        assert.ok(Math.abs((convertCurrency(rates, 'USD', 'GBP', 120) ?? 0) - 80) < 1e-9);
        assert.equal(convertCurrency(rates, 'USD', 'XXX', 1), null);
    });
});
