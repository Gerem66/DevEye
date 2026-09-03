import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AUDIENCE_ANSWER_VALUE_MAX_LENGTH } from '../contracts/domain';

import { indexableAnswers } from './answers';

/**
 * Les règles qui décident ce qu'on compte dans un retour. Elles sont rejouées à
 * l'identique à la suppression pour défaire les compteurs : les tenir ici est
 * ce qui empêche les deux chemins de diverger en silence.
 */

describe('indexableAnswers', () => {
    it('rend une entrée par question, dans l’ordre du retour', () => {
        assert.deepEqual(indexableAnswers({ nom: 'Ada', ville: 'Lyon' }), [
            { field: 'nom', value: 'Ada' },
            { field: 'ville', value: 'Lyon' }
        ]);
    });

    it('ramène un nombre et un booléen à leur forme textuelle', () => {
        // Un formulaire HTML envoie « 4 », un appel JSON envoie 4 : c'est la même
        // réponse, et deux lignes de répartition seraient un doublon.
        assert.deepEqual(indexableAnswers({ note: 4, ok: true, prix: 4.5 }), [
            { field: 'note', value: '4' },
            { field: 'ok', value: 'true' },
            { field: 'prix', value: '4.5' }
        ]);
    });

    it('éclate un choix multiple en une entrée par case cochée', () => {
        assert.deepEqual(indexableAnswers({ canaux: ['mail', 'sms'] }), [
            { field: 'canaux', value: 'mail' },
            { field: 'canaux', value: 'sms' }
        ]);
    });

    it('envoie au seau ce qui n’est pas un choix : texte long, vide, absent', () => {
        assert.deepEqual(
            indexableAnswers({
                message: 'x'.repeat(AUDIENCE_ANSWER_VALUE_MAX_LENGTH + 1),
                vide: '   ',
                absent: null,
                aucun: []
            }),
            [
                { field: 'message', value: null },
                { field: 'vide', value: null },
                { field: 'absent', value: null },
                { field: 'aucun', value: null }
            ]
        );
    });

    it('garde une réponse pile à la longueur limite', () => {
        const value = 'x'.repeat(AUDIENCE_ANSWER_VALUE_MAX_LENGTH);
        assert.deepEqual(indexableAnswers({ code: value }), [{ field: 'code', value }]);
    });

    it('ignore une question sans nom, et rogne les espaces des deux côtés', () => {
        assert.deepEqual(indexableAnswers({ '  ': 'perdu', '  ville  ': '  Lyon  ' }), [
            { field: 'ville', value: 'Lyon' }
        ]);
    });
});
