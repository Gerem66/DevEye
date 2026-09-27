import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderAccountMail } from '@/Services/mailLayout';
import { verificationMail } from '@/Services/signup/mails';
import { mailCatalog, renderSample } from './catalog';

const ctx = { origins: { app: 'https://app.test', public: 'https://app.test', site: 'https://site.test' }, now: 0 };

describe('le catalogue des mails', () => {
    it('le socle d’abord, chaque clé préfixée par sa source et unique', () => {
        const catalog = mailCatalog();
        assert.equal(catalog[0].fullKey, 'core.signupVerification');
        assert.equal(new Set(catalog.map((e) => e.fullKey)).size, catalog.length);
    });

    it('un mail du serveur rendu exactement comme il part', async () => {
        const entry = mailCatalog().find((e) => e.fullKey === 'core.signupVerification')!;
        const rendered = await renderSample(entry, ctx);
        const real = renderAccountMail(verificationMail('Camille', 'https://app.test/signup/verify#exemple'));
        assert.deepEqual(rendered, { ...real, attachments: [] });
    });

    it('aucun mail du socle ne porte de tiret cadratin', async () => {
        for (const entry of mailCatalog().filter((e) => e.fullKey.startsWith('core.'))) {
            const rendered = await renderSample(entry, ctx);
            assert.doesNotMatch(`${rendered.subject}${rendered.text}${rendered.html ?? ''}`, /—/, entry.fullKey);
        }
    });
});
