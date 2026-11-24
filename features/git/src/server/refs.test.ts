import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createTestContext } from '@deveye/types/sdk/testing';

import { gitTree } from './copy';
import { authorRef, branchRef, slugRef, tagRef } from './refs';

const { keys } = createTestContext();

describe('les condensés de Git', () => {
    it('un dépôt se reconnaît à la casse près dans son espace, et pas d’un espace à l’autre', () => {
        assert.equal(slugRef(keys, 1, ' Gerem66', 'DevEye '), slugRef(keys, 1, 'gerem66', 'deveye'));
        assert.notEqual(slugRef(keys, 1, 'gerem66', 'deveye'), slugRef(keys, 2, 'gerem66', 'deveye'));
        assert.match(slugRef(keys, 1, 'gerem66', 'deveye'), /^[0-9a-f]{32}$/);
    });

    it('un auteur se reconnaît à la casse et aux espaces près dans son dépôt, une branche et un tag à la lettre', () => {
        assert.equal(authorRef(keys, 7, '  Gerem@Example.com '), authorRef(keys, 7, 'gerem@example.com'));
        assert.notEqual(authorRef(keys, 7, 'gerem@example.com'), authorRef(keys, 7, 'autre@example.com'));
        assert.notEqual(authorRef(keys, 7, 'gerem@example.com'), authorRef(keys, 8, 'gerem@example.com'));
        assert.notEqual(branchRef(keys, 7, 'Main'), branchRef(keys, 7, 'main'));
        assert.equal(branchRef(keys, 7, 'feature/x'), branchRef(keys, 7, 'feature/x'));
        // Une branche et un tag du même nom ne se confondent pas.
        assert.notEqual(branchRef(keys, 7, 'v1'), tagRef(keys, 7, 'v1'));
    });

    it('l’arbre relit de chaque ligne la valeur que la synchronisation a condensée', () => {
        const digestOf = (table: string) => {
            const digest = gitTree.find((t) => t.table === table)?.digests?.[0];
            assert.ok(digest, table);
            return (stored: object, repoId: number, workspaceId = 1) => {
                const value = digest.of(JSON.stringify(stored));
                assert.ok(value !== null);
                return keys.ref(digest.purpose, digest.within === 'workspace' ? workspaceId : repoId, value);
            };
        };
        assert.equal(
            digestOf('git_repos')({ owner: 'Gerem66', repo: 'DevEye' }, 7),
            slugRef(keys, 1, 'gerem66', 'deveye')
        );
        const commit = { message: 'm', authorName: 'G', authorEmail: 'Gerem@Example.com', url: 'u' };
        const author = { name: 'G', email: 'gerem@example.com ' };
        // Un commit et la ligne de son auteur portent le même condensé : c'est par lui qu'ils se retrouvent.
        assert.equal(digestOf('git_commits')(commit, 7), authorRef(keys, 7, 'gerem@example.com'));
        assert.equal(digestOf('git_commit_authors')(author, 7), authorRef(keys, 7, 'gerem@example.com'));
        assert.equal(digestOf('git_branches')({ name: 'main' }, 7), branchRef(keys, 7, 'main'));
        assert.equal(
            digestOf('git_releases')({ tag: 'v1.0.0', name: '', body: '', url: '' }, 7),
            tagRef(keys, 7, 'v1.0.0')
        );
        assert.equal(gitTree.find((t) => t.table === 'git_pull_requests')?.digests?.length, 0);
    });
});
