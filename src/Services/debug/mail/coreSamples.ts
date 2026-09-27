import type { SdkMailSample } from '@deveye/types/sdk/server';

import { accountDeletedMail } from '@/Services/accountMails';
import { alertMail, sampleAlert } from '@/Services/notifications';
import { existingAccountMail, verificationMail } from '@/Services/signup/mails';

const HOLDER = 'Camille';

/** Les mails du socle, construits par les mêmes fonctions qu'en vrai. */
export const CORE_MAIL_SAMPLES: readonly SdkMailSample[] = [
    {
        key: 'signupVerification',
        label: 'Inscription : valider l’adresse',
        sender: 'server',
        build: ({ origins }) => verificationMail(HOLDER, `${origins.app}/signup/verify#exemple`)
    },
    {
        key: 'signupExisting',
        label: 'Inscription sur une adresse déjà inscrite',
        sender: 'server',
        build: ({ origins }) => existingAccountMail(origins.app)
    },
    {
        key: 'accountDeletedSelf',
        label: 'Compte supprimé par son titulaire',
        sender: 'server',
        build: ({ origins, now }) =>
            accountDeletedMail({
                username: HOLDER,
                by: 'self',
                at: Math.floor(now / 1000),
                notes: [],
                site: origins.site
            })
    },
    {
        key: 'accountDeletedAdmin',
        label: 'Compte supprimé par l’administration',
        sender: 'server',
        build: ({ origins, now }) =>
            accountDeletedMail({
                username: HOLDER,
                by: 'admin',
                at: Math.floor(now / 1000),
                notes: [],
                site: origins.site
            })
    },
    {
        key: 'notificationAlert',
        label: 'Alerte d’un canal e-mail',
        sender: 'workspace',
        build: () => alertMail(sampleAlert('Canal e-mail'))
    }
];
