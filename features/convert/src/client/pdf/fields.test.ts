import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fieldLabel, fieldsOf, fieldViewRect } from './fields';

describe('champs d’un formulaire', () => {
    it('lit textes, cases, boutons radio et listes, et passe le reste', () => {
        const fields = fieldsOf([
            {
                subtype: 'Widget',
                fieldName: 'nom',
                fieldType: 'Tx',
                fieldValue: 'Bob',
                rect: [10, 20, 110, 40],
                multiLine: false
            },
            {
                subtype: 'Widget',
                fieldName: 'ok',
                fieldType: 'Btn',
                checkBox: true,
                exportValue: 'Oui',
                fieldValue: 'Oui',
                rect: [10, 60, 30, 80]
            },
            {
                subtype: 'Widget',
                fieldName: 'taille',
                fieldType: 'Btn',
                radioButton: true,
                buttonValue: 'L',
                fieldValue: 'M',
                rect: [10, 90, 30, 110]
            },
            {
                subtype: 'Widget',
                fieldName: 'pays',
                fieldType: 'Ch',
                options: [{ exportValue: 'FR', displayValue: 'France' }],
                fieldValue: ['FR'],
                rect: [10, 120, 110, 140]
            },
            { subtype: 'Widget', fieldName: 'go', fieldType: 'Btn', pushButton: true, rect: [0, 0, 1, 1] },
            { subtype: 'Widget', fieldName: 'sig', fieldType: 'Sig', rect: [0, 0, 1, 1] },
            { subtype: 'Widget', fieldName: 'caché', fieldType: 'Tx', hidden: true, rect: [0, 0, 1, 1] },
            { subtype: 'Link', rect: [0, 0, 1, 1] }
        ]);
        assert.deepEqual(
            fields.map((f) => [f.name, f.kind, f.value, f.onValue]),
            [
                ['nom', 'text', 'Bob', null],
                ['ok', 'checkbox', true, 'Oui'],
                ['taille', 'radio', 'M', 'L'],
                ['pays', 'choice', 'FR', null]
            ]
        );
        assert.deepEqual(fields[3].options, [{ value: 'FR', label: 'France' }]);
    });

    it('place le widget dans le cadre affiché, page tournée comprise', () => {
        const [field] = fieldsOf([{ subtype: 'Widget', fieldName: 'a', fieldType: 'Tx', rect: [10, 20, 110, 40] }]);
        assert.deepEqual(fieldViewRect(field, { view: [0, 0, 400, 600], rotation: 0 }), {
            x: 10,
            y: 560,
            width: 100,
            height: 20
        });
        assert.deepEqual(fieldViewRect(field, { view: [0, 0, 400, 600], rotation: 90 }), {
            x: 20,
            y: 10,
            width: 20,
            height: 100
        });
        assert.equal(fieldLabel('client.adresse.ville'), 'ville');
    });
});
