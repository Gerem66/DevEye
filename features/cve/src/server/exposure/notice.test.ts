import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_EXPOSURE_PREFS } from '../../contracts/exposure';
import { findingAlert, firstScanAlert, isAlertable, type AlertedFinding } from './notice';

/** Ce qui part, et comment : une alerte par faille, qui se lit sans l'embed. */

const lodash: AlertedFinding = {
    kind: 'vuln',
    advisoryId: 'CVE-2020-8203',
    severity: 'high',
    score: 7.4,
    reopened: false,
    content: {
        title: 'lodash : Prototype pollution in lodash',
        summary: '',
        subject: { kind: 'package', ecosystem: 'npm', name: 'lodash' },
        fixed: ['4.17.21'],
        reference: 'https://osv.dev/vulnerability/GHSA-p6mc',
        aliases: [],
        affected: [
            { assetId: 1, version: '4.17.20', path: 'package-lock.json', line: null },
            { assetId: 2, version: '4.17.15', path: 'client/package-lock.json', line: null }
        ]
    }
};

describe('les avis de la veille', () => {
    it('suivent le réglage de chaque genre, et le seuil de gravité des failles', () => {
        assert.equal(isAlertable(lodash, DEFAULT_EXPOSURE_PREFS), true);
        assert.equal(isAlertable({ ...lodash, severity: 'medium' }, DEFAULT_EXPOSURE_PREFS), false);
        assert.equal(
            isAlertable({ ...lodash, severity: 'none' }, { ...DEFAULT_EXPOSURE_PREFS, threshold: 'all' }),
            true
        );
        assert.equal(
            isAlertable(lodash, {
                ...DEFAULT_EXPOSURE_PREFS,
                alerts: { ...DEFAULT_EXPOSURE_PREFS.alerts, vuln: false }
            }),
            false
        );
        assert.equal(isAlertable({ ...lodash, kind: 'outdated' }, DEFAULT_EXPOSURE_PREFS), false);
    });

    it('nomment la faille et ce qu’elle touche, en lignes « Clé : valeur »', () => {
        const alert = findingAlert(lodash, (id) => `o/app${id}`);
        assert.equal(alert.subject, '🐞 CVE-2020-8203 (gravité élevée 7.4) touche 2 éléments');
        assert.match(alert.body, /^Touche : o\/app1, o\/app2$/m);
        assert.match(alert.body, /^Composant : lodash 4\.17\.20, 4\.17\.15$/m);
        assert.match(alert.body, /^Corrigé en : 4\.17\.21$/m);
        assert.ok(!/ {2,}:/.test(alert.body), 'aucun alignement par des espaces');
        assert.equal(alert.embeds?.length, 1);
    });

    it('récapitulent un premier inventaire en un seul avis', () => {
        const alert = firstScanAlert([
            { label: 'o/app1', critical: 1, vulns: 3, others: 0 },
            { label: 'o/app2', critical: 0, vulns: 0, others: 1 }
        ]);
        assert.equal(alert.subject, '🐞 Premier inventaire : 4 constats dans 2 éléments');
        assert.match(alert.body, /^o\/app1 : 3 failles dont 1 critique$/m);
        assert.match(alert.body, /^o\/app2 : 1 autre constat$/m);
    });
});
