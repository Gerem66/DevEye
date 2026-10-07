import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { MinimalUser } from '@deveye/types';
import type { ProjectCard, ProjectChecklistItem } from '../../contracts/domain';
import { cardSearch, orderWithHidden } from './search';

const alice = { id: 7, username: 'Alice' } as MinimalUser;

const item = (label: string, assigneeUserId: number | null = null): ProjectChecklistItem =>
    ({ id: label, label, assigneeUserId }) as ProjectChecklistItem;

const card = (over: Partial<ProjectCard> = {}): ProjectCard =>
    ({ title: '', description: '', checklist: [], assigneeUserId: null, ...over }) as ProjectCard;

describe('cardSearch', () => {
    it('ne filtre rien quand la recherche est vide', () => {
        assert.equal(cardSearch('   ', [alice]), null);
    });

    it('cherche sans casse ni accents, dans le titre, la description et les sous-tâches', () => {
        const matches = cardSearch('ecran', [])!;
        assert.ok(matches(card({ title: 'Écran de connexion' })));
        assert.ok(matches(card({ description: "L'ÉCRAN clignote" })));
        assert.ok(matches(card({ checklist: [item('Refaire l’écran')] })));
        assert.ok(!matches(card({ title: 'Connexion' })));
    });

    it('trouve une tâche par qui la porte, ou porte une de ses sous-tâches', () => {
        const matches = cardSearch('alice', [alice])!;
        assert.ok(matches(card({ assigneeUserId: 7 })));
        assert.ok(matches(card({ checklist: [item('Relire', 7)] })));
        assert.ok(!matches(card({ assigneeUserId: 8 })));
    });

    it('ne nomme pas un membre hors de cet espace', () => {
        assert.ok(!cardSearch('alice', [])!(card({ assigneeUserId: 7 })));
    });

    it('veut chaque mot, où qu’il soit dans la tâche', () => {
        const matches = cardSearch('alice connexion', [alice])!;
        assert.ok(matches(card({ title: 'Connexion', assigneeUserId: 7 })));
        assert.ok(!matches(card({ title: 'Connexion' })));
    });
});

describe('orderWithHidden', () => {
    it('ne touche pas une colonne sans tâche masquée', () => {
        assert.deepEqual(orderWithHidden([1, 2, 3], [3, 1, 2], 3), [3, 1, 2]);
        assert.deepEqual(orderWithHidden([1, 2, 3], [2, 3, 1], 1), [2, 3, 1]);
    });

    it('pose la carte juste après sa voisine visible du dessus', () => {
        // 2 et 4 sont masquées : 5 monte entre 1 et 3.
        assert.deepEqual(orderWithHidden([1, 2, 3, 4, 5], [1, 5, 3], 5), [1, 5, 2, 3, 4]);
    });

    it('en tête, juste avant sa voisine du dessous', () => {
        assert.deepEqual(orderWithHidden([1, 2, 3, 4], [4, 2], 4), [1, 4, 2, 3]);
    });

    it("garde l'ordre des masquées pour une carte venue d'une autre colonne", () => {
        assert.deepEqual(orderWithHidden([1, 2, 3], [1, 9, 3], 9), [1, 9, 2, 3]);
        assert.deepEqual(orderWithHidden([1, 2, 3], [1, 3, 9], 9), [1, 2, 3, 9]);
        assert.deepEqual(orderWithHidden([1, 2], [9], 9), [1, 2, 9]);
    });
});
