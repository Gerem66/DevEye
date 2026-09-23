import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { movableCellsOf, type SdkCipher, type SdkQueryable } from '@deveye/types/sdk/server';

import { audienceMove } from './move';
import { audienceTree } from './copy';
import type { AudienceIngest } from './service';
import { setIngest } from './_shared';

/**
 * Le changement d'espace d'un site. Deux invariants que rien ne signale quand
 * ils cèdent, le chiffrement ne rendant aucune erreur : la liste des colonnes à
 * resceller, et la purge du cache de l'ingestion.
 */

/** Un site sans aucune cellule à resceller : le déplacement tient en deux requêtes. */
function fakeQueryable(): { q: SdkQueryable; updates: string[] } {
    const updates: string[] = [];
    const q: SdkQueryable = {
        async query<T extends object>(sql: string): Promise<T[]> {
            if (sql.includes('MAX(sort_order)')) return [{ next: 3 } as unknown as T];
            return [];
        },
        async execute(sql: string) {
            updates.push(sql);
            return { affectedRows: 1, insertId: 0 };
        }
    };
    return { q, updates };
}

const ciphers = {
    from: { encrypt: async (v: string) => v, tryDecrypt: async (v: string) => v } as unknown as SdkCipher,
    to: { encrypt: async (v: string) => v, tryDecrypt: async (v: string) => v } as unknown as SdkCipher
};

afterEach(() => setIngest(null));

describe('l’arbre d’un site', () => {
    it('rescelle toutes les colonnes chiffrées, `form_schema` comprise', () => {
        // Les questions déclarées d'un formulaire sont chiffrées comme son nom.
        // Oubliée ici, la colonne reste sous la clé de l'espace quitté, `fields`
        // rend une liste vide, et le formulaire strict refuse tout envoi sans
        // qu'aucune erreur ne paraisse nulle part.
        const cells = movableCellsOf(audienceTree).map((cell) => `${cell.table}.${cell.column}`);
        assert.ok(cells.includes('ft_audience_forms.form_schema'), cells.join(', '));
        assert.ok(cells.includes('ft_audience_forms.content'));
    });
});

describe('audienceMove.apply', () => {
    it('vide le cache de l’ingestion : il retient l’espace d’un site sans expiration', async () => {
        let invalidated = 0;
        setIngest({ invalidate: () => void invalidated++ } as unknown as AudienceIngest);
        const { q, updates } = fakeQueryable();

        await audienceMove.apply({
            q,
            repo: undefined as never,
            itemId: '7',
            fromWorkspaceId: 1,
            toWorkspaceId: 42,
            ciphers
        });

        assert.equal(updates.length, 1);
        assert.equal(invalidated, 1, 'sans cette purge, les visites suivantes restent chiffrées chez l’espace quitté');
    });
});
