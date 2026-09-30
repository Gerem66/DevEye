import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { WorkspaceRoleRow } from '@deveye/types';

import { selectColumns } from './columns';

/**
 * La liste de colonnes d'un SELECT doit sortir au caractère près comme elle
 * était écrite à la main : le SQL émis par les dépôts ne doit pas changer en
 * passant par le type.
 */

interface Row {
    id: number;
    label: string;
    owner_name: string | null;
}

describe('la liste de colonnes d’un SELECT', () => {
    it('préfixe de l’alias, garde une expression qui nomme déjà sa colonne, aliase le reste', () => {
        const list = selectColumns<Row>('t', { id: true, label: 'x.label', owner_name: 'o.name' });
        assert.equal(list, 't.id, x.label, o.name AS owner_name');
    });

    it('se passe d’alias', () => {
        assert.equal(
            selectColumns<Row>(null, { id: true, label: true, owner_name: 'MAX(name)' }),
            'id, label, MAX(name) AS owner_name'
        );
    });

    it('rend les colonnes d’un rôle telles qu’elles étaient écrites, avec et sans alias', () => {
        const spec = {
            id: true,
            workspace_id: true,
            name: true,
            color: true,
            position: true,
            capabilities: true,
            features: true,
            is_default: true,
            created: true
        } as const;
        assert.equal(
            selectColumns<WorkspaceRoleRow>(null, spec),
            'id, workspace_id, name, color, position, capabilities, features, is_default, created'
        );
        assert.equal(
            selectColumns<WorkspaceRoleRow>('r', spec),
            'r.id, r.workspace_id, r.name, r.color, r.position, r.capabilities, r.features, r.is_default, r.created'
        );
    });
});
