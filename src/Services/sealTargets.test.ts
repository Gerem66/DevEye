import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

import Encryption from './Encryption';
import { CORE_SEAL_TARGETS, isCurrentSealFormat, sealTargets, sealVersionOf } from './sealTargets';

test('chaque cible du socle figure dans le tableau de KEY_ROTATION.md', () => {
    const doc = readFileSync(resolve(process.cwd(), 'Docs/KEY_ROTATION.md'), 'utf8');
    for (const t of CORE_SEAL_TARGETS) {
        assert.ok(doc.includes(`${t.table}.${t.column}`), `${t.table}.${t.column} absent de la doc`);
    }
});

test('une colonne déclarée par un module prend son étiquette, et un contexte vide par défaut', () => {
    const targets = sealTargets([
        {
            manifest: { id: 'x-demo' },
            server: {
                sealed: [
                    { table: 'ft_demo_keys', column: 'sealed', id: 'id' },
                    { table: 'ft_demo_reports', column: 'content', id: 'ref', context: (ref) => `ft_demo:${ref}` }
                ]
            }
        }
    ]);
    const [root, report] = targets.slice(CORE_SEAL_TARGETS.length);
    assert.equal(root.label, 'module:x-demo');
    assert.equal(root.context(1), '');
    assert.equal(report.context('AB12'), 'ft_demo:AB12');
});

test('sealVersionOf lit l’octet de version, et un blob scellé est au format courant', () => {
    const crypt = new Encryption('a'.repeat(32), 'b'.repeat(32));
    const sealed = crypt.sealFor('totp', 'secret', 'user_2fa:secret:1');
    assert.equal(sealVersionOf(sealed), 0x02);
    assert.ok(isCurrentSealFormat(sealed));
    assert.equal(sealVersionOf(''), null);
});

test('un blob scellé ne s’ouvre ni sous une autre étiquette ni sous un autre contexte', () => {
    const crypt = new Encryption('a'.repeat(32), 'b'.repeat(32));
    const sealed = crypt.sealFor('user-dek', Buffer.alloc(32, 7), 'user_secret_keys:dek:1');
    assert.ok(crypt.openFor('user-dek', sealed, 'user_secret_keys:dek:1'));
    assert.equal(crypt.openFor('user-open-dek', sealed, 'user_secret_keys:dek:1'), null);
    assert.equal(crypt.openFor('user-dek', sealed, 'user_secret_keys:dek:2'), null);
    assert.equal(crypt.openFor('module:cloudsync', sealed, ''), null);
});
