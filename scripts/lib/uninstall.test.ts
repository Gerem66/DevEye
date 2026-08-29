import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { forbiddenUninstallTargets, scrubHomeLayout, scrubRoleGrants } from './uninstall';

/**
 * La part pure de la désinstallation d'un module : la sentinelle du
 * `uninstall.sql`, et les deux nettoyages de JSON, où un bug silencieux
 * corromprait les rôles ou les accueils de tous les espaces d'un coup.
 */

describe('forbiddenUninstallTargets', () => {
    it('accepte un démontage borné au préfixe du module', () => {
        const sql = 'DROP TABLE IF EXISTS ft_countdown_items;\nDROP TABLE IF EXISTS ft_countdown_meta;';
        assert.deepEqual(forbiddenUninstallTargets('x-countdown', sql), []);
    });

    it("refuse une table d'un autre préfixe, allowlist ou pas", () => {
        const sql = 'DROP TABLE IF EXISTS ft_countdown_items;\nDROP TABLE osint_lookups;';
        assert.deepEqual(forbiddenUninstallTargets('x-countdown', sql), ['osint_lookups']);
    });

    it('voit aussi un DELETE ou un TRUNCATE, pas seulement les DROP', () => {
        assert.deepEqual(forbiddenUninstallTargets('x-countdown', 'DELETE FROM feature_kv;'), ['feature_kv']);
        assert.deepEqual(forbiddenUninstallTargets('x-countdown', 'TRUNCATE TABLE workspaces;'), ['workspaces']);
    });
});

describe('scrubRoleGrants', () => {
    const grants = JSON.stringify([
        { feature: 'x-countdown', access: 'write', extras: { manage: true } },
        { feature: 'notes', access: 'read' }
    ]);

    it('retire le grant entier de la feature (droit, extras et tout)', () => {
        const next = scrubRoleGrants(grants, 'x-countdown');
        assert.ok(next);
        assert.deepEqual(JSON.parse(next), [{ feature: 'notes', access: 'read' }]);
    });

    it('rend null quand le rôle ne porte pas la feature — rien à écrire', () => {
        assert.equal(scrubRoleGrants(grants, 'x-autre'), null);
    });

    it('tolère un JSON invalide plutôt que de le remplacer', () => {
        assert.equal(scrubRoleGrants('pas du json', 'x-countdown'), null);
    });
});

describe('scrubHomeLayout', () => {
    const layout = JSON.stringify({
        topbar: ['secrecy', 'x-countdown'],
        sections: [
            {
                id: 's1',
                items: [
                    'notes',
                    'x-countdown',
                    { kind: 'folder', id: 'f1', title: 'Outils', items: ['x-countdown', 'weather'] },
                    { id: 'sc1', title: 'Lien', url: 'https://example.com' }
                ]
            }
        ]
    });

    it('retire la tuile, le mini-widget et les entrées de dossier, sans toucher au reste', () => {
        const next = scrubHomeLayout(layout, 'x-countdown');
        assert.ok(next);
        const parsed = JSON.parse(next) as {
            topbar: string[];
            sections: { items: unknown[] }[];
        };
        assert.deepEqual(parsed.topbar, ['secrecy']);
        assert.deepEqual(parsed.sections[0].items, [
            'notes',
            { kind: 'folder', id: 'f1', title: 'Outils', items: ['weather'] },
            { id: 'sc1', title: 'Lien', url: 'https://example.com' }
        ]);
    });

    it("rend null quand la feature n'apparaît nulle part — rien à écrire", () => {
        assert.equal(scrubHomeLayout(layout, 'x-autre'), null);
    });
});
