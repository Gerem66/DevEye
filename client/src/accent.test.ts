import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { accentFor, accentVars, luminance } from './accent';

const PRESETS = ['#22d3ee', '#2dd4bf', '#3b82f6', '#818cf8', '#a78bfa', '#34d399', '#fbbf24', '#fb7185'];

const contrast = (a: string, b: string) => {
    const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
};

describe('accentFor', () => {
    it('laisse l’accent tel quel en sombre', () => {
        assert.equal(accentFor('#22d3ee', 'dark'), '#22d3ee');
    });

    it('tient 4,5:1 sur le verre clair et sous du texte blanc, pour chaque préréglage', () => {
        for (const hex of PRESETS) {
            const light = accentFor(hex, 'light');
            assert.ok(contrast(light, '#f6f8fa') >= 4.5, `${hex} → ${light} sur le verre`);
            assert.ok(contrast(light, '#ffffff') >= 4.5, `${hex} → ${light} sous du blanc`);
        }
    });

    it('ne touche pas un accent déjà assez foncé', () => {
        assert.equal(accentFor('#0e7490', 'light'), '#0e7490');
    });
});

describe('accentVars', () => {
    it('met du blanc sur l’accent en clair', () => {
        assert.equal(accentVars('#fbbf24', 'light')['--on-accent'], '#ffffff');
    });
});
