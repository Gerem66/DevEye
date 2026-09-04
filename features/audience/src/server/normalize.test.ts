import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    dayBounds,
    dayKey,
    normalizeHost,
    normalizePath,
    normalizeReferrer,
    originAllowed,
    persistentVisitorRef,
    visitorRef
} from './normalize';
import { looksLikeBot, parseUserAgent } from './userAgent';

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

describe('normalizeHost et normalizeReferrer', () => {
    it('rendent l’hôte seul, quelle que soit la forme, et taisent les navigations internes', () => {
        assert.equal(normalizeHost('https://Exemple.fr/'), 'exemple.fr');
        assert.equal(normalizeHost('exemple.fr:443/chemin?q#a'), 'exemple.fr');
        // Une IPv6 littérale garde ses deux-points : le port n'en est pas séparé.
        assert.equal(normalizeHost('[::1]:3000'), '[::1]:3000');
        assert.equal(normalizeReferrer('https://google.fr/search?q=x', ['exemple.fr']), 'google.fr');
        assert.equal(normalizeReferrer('https://exemple.fr/page', ['exemple.fr']), null);
        assert.equal(normalizeReferrer(undefined, []), null);
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
    it('sont stables, sensibles à chaque champ, et différents d’un site à l’autre', () => {
        const ref = visitorRef('sel', 'pk_a', '203.0.113.7', 'UA');
        assert.equal(ref, visitorRef('sel', 'pk_a', '203.0.113.7', 'UA'));
        assert.equal(ref.length, 16);
        assert.notEqual(ref, visitorRef('autre', 'pk_a', '203.0.113.7', 'UA'));
        assert.notEqual(ref, visitorRef('sel', 'pk_b', '203.0.113.7', 'UA'));
        assert.notEqual(ref, visitorRef('sel', 'pk_a', '203.0.113.8', 'UA'));
        assert.notEqual(ref, visitorRef('sel', 'pk_a', '203.0.113.7', 'UB'));
        assert.notEqual(persistentVisitorRef('s', 'pk_a', 'id'), persistentVisitorRef('s', 'pk_b', 'id'));
    });

    it('découpent les jours en UTC', () => {
        // 2026-08-28 12:00:00 UTC.
        const ts = Date.UTC(2026, 7, 28, 12) / 1000;
        assert.equal(dayKey(ts), 20260828);
        assert.deepEqual(dayBounds(ts), { from: Date.UTC(2026, 7, 28) / 1000, to: Date.UTC(2026, 7, 29) / 1000 });
    });
});

describe('parseUserAgent et looksLikeBot', () => {
    it('vont du plus spécifique au plus général', () => {
        const edge = 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/126.0 Safari/537.36 Edg/126.0';
        const androidTablet = 'Mozilla/5.0 (Linux; Android 14; SM-X910) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';
        const iphone =
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1';
        assert.deepEqual(parseUserAgent(edge), { browser: 'Edge', os: 'Windows', device: 'desktop' });
        assert.deepEqual(parseUserAgent(androidTablet), { browser: 'Chrome', os: 'Android', device: 'tablet' });
        assert.deepEqual(parseUserAgent(iphone), { browser: 'Safari', os: 'iOS', device: 'mobile' });
        assert.deepEqual(parseUserAgent(''), { browser: 'Autre', os: 'Autre', device: 'desktop' });
        assert.equal(looksLikeBot('Mozilla/5.0 (compatible; Googlebot/2.1)'), true);
        assert.equal(looksLikeBot(edge), false);
    });
});
