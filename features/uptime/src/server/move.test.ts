import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FeatureError, type SdkCipher, type SdkQueryable } from '@deveye/types/sdk/server';

import { uptimeMove } from './move';
import type { UptimeRepo } from './repo';

/**
 * Le contrôle décisif du déplacement : ce qui part sous la clé de l'espace
 * quitté arrive sous celle du nouveau, et une seule ligne illisible annule tout
 * SANS avoir rien écrit. Un arbre à moitié converti serait définitivement
 * illisible, et rien ne pourrait le détecter.
 */

interface Written {
    sql: string;
    params: unknown[];
}

/**
 * Un `SdkQueryable` qui ne comprend du SQL que le nom de table : assez pour
 * rendre les cellules d'une table et retenir ce qu'on a tenté d'écrire.
 */
function fakeQueryable(cells: Record<string, { row_id: number; value: string }[]>) {
    const writes: Written[] = [];
    const q: SdkQueryable = {
        query: async <T extends object>(sql: string) => {
            // La colonne compte autant que la table : `content` et `last_error`
            // sortent tous deux d'`uptime_services`.
            const m = /AS row_id, (\w+) AS value\s+FROM (\w+)/.exec(sql);
            return (m ? (cells[`${m[2]}.${m[1]}`] ?? []) : []) as T[];
        },
        execute: async (sql: string, params?: unknown[]) => {
            writes.push({ sql, params: params ?? [] });
            return { affectedRows: 1, insertId: 0 };
        }
    };
    return { q, writes };
}

/** Deux codecs qui étiquettent leur espace : la clé se lit dans le blob. */
function cipherOf(tag: string): SdkCipher {
    return {
        encrypt: async (plain) => `${tag}:${plain}`,
        decrypt: async (blob) => blob.slice(tag.length + 1),
        tryDecrypt: async (blob) => (blob.startsWith(`${tag}:`) ? blob.slice(tag.length + 1) : null)
    };
}

const ciphers = { from: cipherOf('A'), to: cipherOf('B') };

/** Le dépôt ne sert à rien ici : tout passe par le queryable. */
const repo = {} as UptimeRepo;

describe('uptime : changement d’espace', () => {
    it('rescelle chaque cellule sous la clé de l’espace cible, puis re-domicilie la ligne', async () => {
        const { q, writes } = fakeQueryable({
            'uptime_services.content': [{ row_id: 7, value: 'A:{"name":"api"}' }],
            'uptime_services.last_error': [],
            'uptime_checks.error': [{ row_id: 11, value: 'A:timeout' }],
            'uptime_incidents.error': [{ row_id: 3, value: 'A:502' }]
        });

        await uptimeMove.apply({ q, repo, itemId: '7', fromWorkspaceId: 1, toWorkspaceId: 2, ciphers });

        // Chaque colonne s'écrit en un paquet `CASE id WHEN ? THEN ?` : la
        // valeur rescellée suit l'identifiant.
        assert.deepEqual(
            writes.slice(0, 3).map((w) => w.params[1]),
            ['B:{"name":"api"}', 'B:timeout', 'B:502']
        );
        // Le domicile change une fois tout le reste converti.
        assert.match(writes[3]!.sql, /UPDATE uptime_services SET workspace_id/);
        assert.deepEqual(writes[3]!.params, [2, 7, 1]);
        // Puis le service quitte les pages de statut de l'espace qu'il quitte.
        assert.match(writes[4]!.sql, /DELETE FROM ft_uptime_page_services WHERE service_id/);
        assert.deepEqual(writes[4]!.params, [7]);
    });

    it('une cellule illisible annule tout, et rien n’a été écrit', async () => {
        const { q, writes } = fakeQueryable({
            'uptime_services.content': [{ row_id: 7, value: 'A:{"name":"api"}' }],
            'uptime_services.last_error': [],
            // Scellée sous une troisième clé : indéchiffrable ici.
            'uptime_checks.error': [{ row_id: 11, value: 'Z:timeout' }],
            'uptime_incidents.error': []
        });

        await assert.rejects(
            uptimeMove.apply({ q, repo, itemId: '7', fromWorkspaceId: 1, toWorkspaceId: 2, ciphers }),
            (err: unknown) => err instanceof FeatureError && /illisible/.test(err.message)
        );
        assert.equal(writes.length, 0);
    });

    it('refuse de re-domicilier une ligne qui n’est plus dans l’espace d’origine', async () => {
        const { q } = fakeQueryable({
            'uptime_services.content': [],
            'uptime_services.last_error': [],
            'uptime_checks.error': [],
            'uptime_incidents.error': []
        });
        const silent: SdkQueryable = { ...q, execute: async () => ({ affectedRows: 0, insertId: 0 }) };

        await assert.rejects(
            uptimeMove.apply({
                q: silent,
                repo,
                itemId: '7',
                fromWorkspaceId: 1,
                toWorkspaceId: 2,
                ciphers
            }),
            (err: unknown) => err instanceof FeatureError && err.code === 'not_found'
        );
    });

    it('annonce le nombre de cellules à convertir, le retrait de ses pages, et aucun refus', async () => {
        // Le compte vient d'un `SELECT COUNT(*)` par cellule, et d'un pour ses
        // pages de statut : le faux dépôt rend deux lignes à chaque fois.
        const { q } = fakeQueryable({});
        const counting: SdkQueryable = { ...q, query: async <T extends object>() => [{ n: 2 }] as T[] };
        const plan = await uptimeMove.plan({
            q: counting,
            repo,
            itemId: '7',
            fromWorkspaceId: 1,
            toWorkspaceId: 2
        });
        // Six cellules : contenu, dernière erreur, référence et verdict d'intégrité, et l'erreur des deux
        // tables d'historique.
        assert.equal(plan.rows, 12);
        assert.deepEqual(plan.blockers, []);
        assert.equal(plan.drops.length, 1);
        assert.match(plan.drops[0]!, /pages de statut/);
    });
});
