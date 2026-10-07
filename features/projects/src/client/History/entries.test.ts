import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ProjectCard, ProjectEvent } from '../../contracts/domain';
import { historyEntries, type HistoryEntry } from './entries';

const event = (id: number, created: number, over: Partial<ProjectEvent> = {}): ProjectEvent =>
    ({ id, created, kind: 'projects.renamed', refType: null, refId: null, ...over }) as ProjectEvent;

const card = (id: number, archivedAt: number | null): ProjectCard => ({ id, archivedAt }) as ProjectCard;

/** `e12` pour l'événement 12, `c3` pour la tâche 3 venue sans événement. */
const keys = (entries: HistoryEntry[]) =>
    entries.map((e) => (e.type === 'event' ? `e${e.event.id}${e.card ? `>c${e.card.id}` : ''}` : `c${e.card.id}`));

describe('historyEntries', () => {
    it("ouvre une tâche par son événement d'archivage, sans la répéter", () => {
        const events = [event(2, 200, { kind: 'card.archived', refType: 'card', refId: 5 }), event(1, 100)];
        assert.deepEqual(keys(historyEntries(events, false, [card(5, 200)])), ['e2>c5', 'e1']);
    });

    it("range les tâches d'une colonne vidée sous l'entrée de la colonne", () => {
        const events = [event(3, 300), event(2, 200, { kind: 'column.purged' }), event(1, 100)];
        const cards = [card(7, 200), card(8, 200)];
        assert.deepEqual(keys(historyEntries(events, false, cards)), ['e3', 'e2', 'c7', 'c8', 'e1']);
    });

    it('retient une tâche plus ancienne que la page chargée', () => {
        const events = [event(3, 300), event(2, 200)];
        assert.deepEqual(keys(historyEntries(events, true, [card(7, 250), card(8, 150)])), ['e3', 'c7', 'e2']);
        assert.deepEqual(keys(historyEntries(events, false, [card(7, 250), card(8, 150)])), ['e3', 'c7', 'e2', 'c8']);
    });

    it('sans événements, rend les tâches archivées de la plus récente à la plus ancienne, les non datées à la fin', () => {
        assert.deepEqual(keys(historyEntries([], false, [card(1, null), card(2, 100), card(3, 300)])), [
            'c3',
            'c2',
            'c1'
        ]);
    });

    it("n'ouvre rien d'une tâche archivée puis restaurée", () => {
        const events = [event(1, 100, { kind: 'card.archived', refType: 'card', refId: 5 })];
        assert.deepEqual(keys(historyEntries(events, false, [])), ['e1']);
    });
});
