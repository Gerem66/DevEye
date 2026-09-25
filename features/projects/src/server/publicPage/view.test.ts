import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ProjectCardRow, ProjectColumnRow } from '../../contracts/domain';
import { priorityFromDb } from '../_shared';
import { buildBoardView, EXCERPT_MAX, initialsOf, type PublicBoardInput } from './view';

function column(id: number, done: boolean): { row: ProjectColumnRow; name: string } {
    return {
        row: {
            id,
            project_id: 1,
            workspace_id: 1,
            sort_order: id,
            counts_as_done: done ? 1 : 0,
            wip_limit: null,
            content: '',
            created: 1
        },
        name: done ? 'Terminé' : 'En cours'
    };
}

function card(id: number, columnId: number, over: Partial<ProjectCardRow> = {}) {
    return {
        row: {
            id,
            project_id: 1,
            workspace_id: 1,
            column_id: columnId,
            sort_order: id,
            author_user_id: 1,
            assignee_user_id: null,
            priority: 0,
            start_date: null,
            due_date: null,
            estimate_minutes: null,
            required_open_count: 0,
            milestone_id: null,
            archived_at: null,
            message_count: 0,
            last_message_at: null,
            content: '',
            created: 1,
            updated: 1,
            ...over
        },
        title: `Carte ${id}`,
        description: '',
        checklist: []
    };
}

function input(over: Partial<PublicBoardInput> = {}): PublicBoardInput {
    return {
        now: 10_000,
        theme: 'auto',
        accent: '',
        project: { title: ' Site ', icon: '', description: '', version: '', status: 'active' },
        columns: [column(1, false), column(2, true)],
        cards: [],
        milestones: [],
        members: new Map(),
        priorityOf: priorityFromDb,
        showDates: true,
        showAssignees: true,
        showSubtasks: false,
        ...over
    };
}

describe('la vue du tableau public', () => {
    it('ne dit pas en retard une échéance passée dans une colonne terminée', () => {
        const view = buildBoardView(
            input({ cards: [card(1, 1, { due_date: 5_000 }), card(2, 2, { due_date: 5_000 })] })
        );
        assert.equal(view.columns[0].cards[0].due?.overdue, true);
        assert.equal(view.columns[1].cards[0].due?.overdue, false);
        assert.deepEqual([view.cardDone, view.cardTotal], [1, 2]);
    });

    it('tait un ancien membre, et ne nomme qu’une fois qui revient sur les sous-tâches', () => {
        const checklist = [7, 7, 8].map((assigneeUserId, i) => ({
            id: String(i),
            label: 'x',
            done: false,
            assigneeUserId,
            required: false,
            createdAt: null,
            doneAt: null,
            doneBy: null
        }));
        const view = buildBoardView(
            input({
                cards: [{ ...card(1, 1, { assignee_user_id: 99 }), checklist }],
                members: new Map([
                    [7, { name: 'Alice', color: 'blue' }],
                    [8, { name: 'Bob Leroy', color: 'red' }]
                ])
            })
        );
        assert.deepEqual(
            view.columns[0].cards[0].assignees.map((a) => a.initials),
            ['A', 'BL']
        );
    });

    it('coupe une longue description, et ne reprend qu’une vignette qui est une image', () => {
        const long = { ...card(1, 1), description: 'mot '.repeat(200) };
        const view = buildBoardView(
            input({
                cards: [long],
                project: {
                    title: '',
                    icon: 'javascript:alert(1)',
                    description: '',
                    version: '',
                    status: 'done'
                }
            })
        );
        assert.equal(view.columns[0].cards[0].excerpt.length, EXCERPT_MAX);
        assert.equal(view.icon, '');
        assert.equal(view.title, 'Sans titre');
        assert.equal(view.status, 'Terminé');
        const png = buildBoardView(
            input({
                project: {
                    title: 'x',
                    icon: 'data:image/png;base64,iVBORw0K',
                    description: '',
                    version: '',
                    status: 'active'
                }
            })
        );
        assert.equal(png.icon, 'data:image/png;base64,iVBORw0K');
    });

    it('ne déplie les sous-tâches qu’avec l’option, et n’y nomme personne sans l’autre', () => {
        const checklist = [
            { id: 'a', label: 'Maquette', done: true, assigneeUserId: 7 },
            { id: 'b', label: ' ', done: false, assigneeUserId: null }
        ].map((item) => ({ ...item, required: false, createdAt: null, doneAt: null, doneBy: null }));
        const members = new Map([[7, { name: 'Alice', color: 'blue' as const }]]);
        const cards = [{ ...card(1, 1), checklist }, card(2, 1)];
        const closed = buildBoardView(input({ cards, members }));
        assert.equal(closed.columns[0].cards[0].subtasks, null);

        const open = buildBoardView(input({ cards, members, showSubtasks: true }));
        assert.deepEqual(open.columns[0].cards[0].subtasks, [
            { label: 'Maquette', done: true, assignee: { initials: 'A', name: 'Alice', color: 'blue' } },
            { label: 'Sans titre', done: false, assignee: null }
        ]);
        // Une carte sans sous-tâche ne se déplie pas.
        assert.equal(open.columns[0].cards[1].subtasks, null);

        const anonymous = buildBoardView(input({ cards, members, showSubtasks: true, showAssignees: false }));
        assert.equal(anonymous.columns[0].cards[0].subtasks?.[0].assignee, null);
    });

    it('tire des initiales lisibles', () => {
        assert.equal(initialsOf('alice'), 'A');
        assert.equal(initialsOf('jean-pierre.dupont'), 'JP');
        assert.equal(initialsOf('  '), '?');
    });
});
