import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { dayBounds, dayKey, normalizePath, originAllowed, persistentVisitorRef } from './normalize';

/**
 * Les règles pures de l'ingestion : ce sont elles qui décident si deux visites
 * comptent pour la même page, et une erreur s'y traduirait par des statistiques
 * fausses plutôt que par une panne.
 */

describe('normalizePath', () => {
    it('retire la requête, l’ancre et la barre finale, accepte une URL complète', () => {
        assert.equal(normalizePath('/produits?utm_source=x#haut'), '/produits');
        assert.equal(normalizePath('/tarifs/'), '/tarifs');
        assert.equal(normalizePath('/'), '/');
        assert.equal(normalizePath(''), '/');
        assert.equal(normalizePath('https://exemple.fr/a/b/?q=1'), '/a/b');
        assert.equal(normalizePath('sans-barre'), '/sans-barre');
    });
});

describe('originAllowed', () => {
    it('ne laisse rien entrer tant qu’aucune origine n’est déclarée', () => {
        // C'est la correction qui compte : la première version acceptait TOUT dans
        // ce cas, ce qui faisait du réglage par défaut le plus permissif de tous.
        for (const platform of ['web', 'app', 'both'] as const) {
            assert.equal(originAllowed([], null, platform), false, platform);
            assert.equal(originAllowed([], 'https://exemple.fr', platform), false, platform);
        }
    });

    it('ouvre à tout sur `*`, quelle que soit la plateforme ou l’origine', () => {
        // Même effet qu'une liste vide autrefois, mais parce qu'on l'a écrit.
        assert.equal(originAllowed(['*'], null, 'web'), true);
        assert.equal(originAllowed(['*'], 'https://autre.fr', 'web'), true);
        assert.equal(originAllowed(['*'], null, 'app'), true);
    });

    it('applique la liste sur les trois plateformes', () => {
        assert.equal(originAllowed(['exemple.fr'], null, 'app'), true);
        assert.equal(originAllowed(['exemple.fr'], 'https://exemple.fr', 'web'), true);
        assert.equal(originAllowed(['exemple.fr'], 'https://autre.fr', 'web'), false);
        assert.equal(originAllowed(['exemple.fr'], null, 'web'), false);
        assert.equal(originAllowed(['exemple.fr'], null, 'both'), true);
        assert.equal(originAllowed(['exemple.fr'], 'https://autre.fr', 'both'), false);
    });
});

describe('les condensés', () => {
    it('sont différents d’un site à l’autre en mode persistant', () => {
        assert.notEqual(persistentVisitorRef('s', 'pk_a', 'id'), persistentVisitorRef('s', 'pk_b', 'id'));
    });

    it('découpent les jours en UTC', () => {
        // 2026-08-28 12:00:00 UTC.
        const ts = Date.UTC(2026, 7, 28, 12) / 1000;
        assert.equal(dayKey(ts), 20260828);
        assert.deepEqual(dayBounds(ts), { from: Date.UTC(2026, 7, 28) / 1000, to: Date.UTC(2026, 7, 29) / 1000 });
    });
});
