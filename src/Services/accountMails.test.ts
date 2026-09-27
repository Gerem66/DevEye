import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { accountDeletedMail } from './accountMails';

describe('le mail de suppression du compte', () => {
    const at = Date.UTC(2026, 8, 27, 16, 30) / 1000;

    it('dit qui a supprimé, quand, et ajoute ce que les modules ont à dire', () => {
        const self = accountDeletedMail({
            username: 'alice',
            by: 'self',
            at,
            notes: ['Abonnement résilié.'],
            site: null
        });
        assert.match(self.paragraphs[1], /Comme vous l’avez demandé.*27 septembre 2026 à 18:30/);
        assert.equal(self.paragraphs.at(-1), 'Abonnement résilié.');
        const admin = accountDeletedMail({ username: 'alice', by: 'admin', at, notes: [], site: 'https://site.test' });
        assert.match(admin.paragraphs[1], /par l’administration du service/);
        assert.match(admin.footnote ?? '', /https:\/\/site\.test\/mentions-legales/);
        assert.doesNotMatch(JSON.stringify([self, admin]), /—/);
    });
});
