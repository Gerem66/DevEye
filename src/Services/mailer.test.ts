import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createMailer, transportOptions } from './mailer';

describe('le mailer du serveur', () => {
    it('n’est pas configuré sans hôte, et refuse alors d’envoyer', async () => {
        const mailer = createMailer({ port: 587 });
        assert.equal(mailer.configured, false);
        await assert.rejects(mailer.send({ to: 'a@exemple.fr', subject: 's', text: 't', html: 'h' }));
    });

    it('déduit le TLS du port : implicite en 465, STARTTLS exigé ailleurs', () => {
        assert.deepEqual(
            {
                secure: transportOptions({ host: 'h', port: 465 }).secure,
                requireTLS: transportOptions({ host: 'h', port: 465 }).requireTLS
            },
            { secure: true, requireTLS: undefined }
        );
        const submission = transportOptions({ host: 'h', port: 587, user: 'u', password: 'p' });
        assert.equal(submission.secure, false);
        assert.equal(submission.requireTLS, true);
        assert.deepEqual(submission.auth, { user: 'u', pass: 'p' });
    });
});
