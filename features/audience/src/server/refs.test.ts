import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createTestContext } from '@deveye/types/sdk/testing';

import { audienceTree } from './copy';
import { formLabelRef, formNameRef, funnelNameRef, labelRef, siteNameRef } from './refs';

const { keys } = createTestContext();

/** Le condensé que l'arbre tire d'une ligne : ce que la reprise et la copie écrivent. */
function fromTree(table: string, stored: string, siteId: number, workspaceId = 1): string {
    const digest = audienceTree.find((t) => t.table === table)?.digests?.[0];
    assert.ok(digest, table);
    const value = digest.of(stored, {});
    assert.ok(value !== null);
    return keys.ref(digest.purpose, digest.within === 'workspace' ? workspaceId : siteId, value);
}

describe('les condensés d’Audience', () => {
    it('un nom se reconnaît à la casse et aux espaces près, un libellé à la lettre', () => {
        assert.equal(siteNameRef(keys, 1, ' Vitrine '), siteNameRef(keys, 1, 'vitrine'));
        assert.equal(funnelNameRef(keys, 7, 'Devis'), funnelNameRef(keys, 7, 'devis '));
        assert.equal(formNameRef(keys, 7, 'Contact'), formNameRef(keys, 7, ' contact'));
        assert.notEqual(labelRef(keys, 7, '/Tarifs'), labelRef(keys, 7, '/tarifs'));
        assert.match(labelRef(keys, 7, '/tarifs'), /^[0-9a-f]{32}$/);
    });

    it('rien ne relie deux espaces ni deux sites, et un usage ne passe pas pour un autre', () => {
        assert.notEqual(siteNameRef(keys, 1, 'vitrine'), siteNameRef(keys, 2, 'vitrine'));
        assert.notEqual(labelRef(keys, 7, '/tarifs'), labelRef(keys, 8, '/tarifs'));
        // Un entonnoir, un formulaire, un libellé mesuré et une réponse du même texte.
        const same = [
            funnelNameRef(keys, 7, 'contact'),
            formNameRef(keys, 7, 'contact'),
            labelRef(keys, 7, 'contact'),
            formLabelRef(keys, 7, 'contact')
        ];
        assert.equal(new Set(same).size, same.length);
    });

    it('l’arbre relit de chaque ligne la valeur que la collecte et la saisie ont condensée', () => {
        assert.equal(
            fromTree('audience_sites', JSON.stringify({ name: ' Vitrine ' }), 7),
            siteNameRef(keys, 1, 'vitrine')
        );
        assert.equal(fromTree('audience_funnels', 'Devis', 7), funnelNameRef(keys, 7, 'devis'));
        assert.equal(fromTree('ft_audience_forms', 'Contact', 7), formNameRef(keys, 7, 'contact'));
        assert.equal(fromTree('ft_audience_form_labels', 'recommande', 7), formLabelRef(keys, 7, 'recommande'));
        // La marche d'un entonnoir et le libellé qu'elle attend portent le même condensé.
        assert.equal(fromTree('audience_funnel_steps', '/tarifs', 7), labelRef(keys, 7, '/tarifs'));
        assert.equal(fromTree('audience_labels', '/tarifs', 7), labelRef(keys, 7, '/tarifs'));
    });
});
