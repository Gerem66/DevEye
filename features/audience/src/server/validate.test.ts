import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AUDIENCE_FIELD_VALUE_MAX_LENGTH, type AudienceFormField } from '../contracts/domain';

import { validateSubmission } from './validate';

/**
 * La confrontation d'un envoi au formulaire déclaré. Deux choses s'y jouent, et
 * la seconde est celle qu'on oublie : refuser ce qui ne colle pas, et
 * **convertir** ce qui colle. Un `<form>` HTML n'envoie que des chaînes, donc
 * sans la conversion la même réponse compterait pour deux valeurs distinctes
 * selon la porte par laquelle elle est entrée.
 */

function field(over: Partial<AudienceFormField> & { name: string }): AudienceFormField {
    return { kind: 'text', required: false, choices: [], multiple: false, ...over };
}

const CONTACT: AudienceFormField[] = [
    field({ name: 'email', kind: 'email', required: true }),
    field({ name: 'note', kind: 'number' }),
    field({ name: 'infolettre', kind: 'boolean' }),
    field({ name: 'sujet', kind: 'choice', choices: ['devis', 'bug'] }),
    field({ name: 'message' })
];

describe('validateSubmission : ce qui passe', () => {
    it('ramène les chaînes d’un formulaire HTML à leur type déclaré', () => {
        // Tout arrive en chaîne : c'est exactement ce qu'un `<form method="post">`
        // produit, et la seule raison pour laquelle le type est déclaré.
        const res = validateSubmission(CONTACT, {
            email: 'Ada@Exemple.FR',
            note: '4',
            infolettre: 'on',
            sujet: 'devis',
            message: '  bonjour  '
        });
        assert.ok(res.ok);
        assert.deepEqual(res.fields, {
            email: 'ada@exemple.fr',
            note: 4,
            infolettre: true,
            sujet: 'devis',
            message: 'bonjour'
        });
    });

    it('accepte la virgule décimale, qui est ce qu’un francophone tape', () => {
        const res = validateSubmission([field({ name: 'prix', kind: 'number' })], { prix: '4,5' });
        assert.ok(res.ok);
        assert.equal(res.fields.prix, 4.5);
    });

    it('garde une question non remplie à null plutôt que de l’effacer', () => {
        // La question a été posée : la faire disparaître de la ligne fausserait le
        // dénombrement de la vue Résultats.
        const res = validateSubmission(CONTACT, { email: 'ada@exemple.fr' });
        assert.ok(res.ok);
        assert.deepEqual(res.fields, {
            email: 'ada@exemple.fr',
            note: null,
            infolettre: null,
            sujet: null,
            message: null
        });
    });

    it('éclate un choix multiple et le refuse sur un champ simple', () => {
        const multi = [field({ name: 'canaux', kind: 'choice', choices: ['mail', 'sms'], multiple: true })];
        const res = validateSubmission(multi, { canaux: ['mail', 'sms'] });
        assert.ok(res.ok);
        assert.deepEqual(res.fields.canaux, ['mail', 'sms']);

        const simple = [field({ name: 'canaux', kind: 'choice', choices: ['mail', 'sms'] })];
        assert.deepEqual(validateSubmission(simple, { canaux: ['mail', 'sms'] }), {
            ok: false,
            field: 'canaux',
            reason: 'choice'
        });
    });
});

describe('validateSubmission : ce qui est refusé', () => {
    const rejects = (input: Record<string, unknown>, field: string, reason: string) =>
        assert.deepEqual(validateSubmission(CONTACT, input as never), { ok: false, field, reason });

    it('refuse un champ que le formulaire ne déclare pas', () => {
        // En entier, et pas en le jetant : le site vient de renommer quelque chose,
        // et l'accepter à moitié rendrait la perte invisible des deux côtés.
        rejects({ email: 'ada@exemple.fr', surprise: 'x' }, 'surprise', 'unknown');
    });

    it('refuse un champ requis absent ou vide', () => {
        rejects({ note: '4' }, 'email', 'missing');
        rejects({ email: '' }, 'email', 'missing');
    });

    it('refuse une valeur qui ne colle pas au type', () => {
        rejects({ email: 'pas-une-adresse' }, 'email', 'type');
        rejects({ email: 'ada@exemple.fr', note: 'beaucoup' }, 'note', 'type');
        rejects({ email: 'ada@exemple.fr', infolettre: 'peut-être' }, 'infolettre', 'type');
    });

    it('refuse un choix hors de la liste déclarée', () => {
        rejects({ email: 'ada@exemple.fr', sujet: 'autre' }, 'sujet', 'choice');
    });

    it('refuse un texte plus long que ce qu’on conserve', () => {
        rejects(
            { email: 'ada@exemple.fr', message: 'x'.repeat(AUDIENCE_FIELD_VALUE_MAX_LENGTH + 1) },
            'message',
            'tooLong'
        );
    });

    it('refuse un tableau derrière une question simple', () => {
        rejects({ email: 'ada@exemple.fr', message: ['a', 'b'] }, 'message', 'type');
    });

    it('refuse tout quand aucun champ n’est déclaré', () => {
        // Le doute profite à la fermeture : c'est ce qui empêche un schéma illisible
        // de faire passer un formulaire strict pour permissif.
        assert.deepEqual(validateSubmission([], { email: 'ada@exemple.fr' }), {
            ok: false,
            field: 'email',
            reason: 'unknown'
        });
    });
});
