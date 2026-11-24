import { itemDigest, type ItemDigestKeys, type ItemTreeDigest } from '@deveye/types/sdk/server';

import type { StoredRepo } from './_shared';

/**
 * Les condensés du module. Le chiffrement n'étant pas déterministe, ce qui doit
 * rester unique ou se regrouper sans être déchiffré (un dépôt dans son espace,
 * une branche, un tag, un auteur dans son dépôt) est doublé d'un condensé à
 * clé. Chaque déclaration sert trois fois : la synchronisation et la saisie
 * calculent par elle, l'arbre de `copy.ts` la porte, et la reprise des lignes
 * existantes la relit.
 */

/** `owner/repo`, insensible à la casse parce que GitHub l'est. */
const comparableSlug = (owner: string, repo: string): string =>
    `${owner.trim().toLowerCase()}/${repo.trim().toLowerCase()}`;

/** Une adresse d'auteur, telle qu'elle se compare. */
const comparableEmail = (email: string): string => email.trim().toLowerCase();

/** L'identité d'un dépôt dans son espace. */
export const SLUG_DIGEST: ItemTreeDigest = {
    column: 'slug_ref',
    purpose: 'slug',
    within: 'workspace',
    from: 'content',
    of: (plain) => {
        const { owner, repo } = JSON.parse(plain) as StoredRepo;
        return comparableSlug(owner, repo);
    }
};

/**
 * L'identité d'un auteur dans son dépôt, sans conserver son adresse en clair.
 * Une ligne d'auteur et les commits qu'il signe portent le même condensé :
 * c'est par lui qu'ils se retrouvent, et qu'un auteur se relie à un membre.
 */
export const AUTHOR_DIGEST: ItemTreeDigest = {
    column: 'author_ref',
    purpose: 'author',
    within: 'item',
    from: 'content',
    of: (plain) => comparableEmail((JSON.parse(plain) as { email: string }).email)
};

/** Le même, lu dans un commit, qui range l'adresse sous un autre nom. */
export const COMMIT_AUTHOR_DIGEST: ItemTreeDigest = {
    ...AUTHOR_DIGEST,
    of: (plain) => comparableEmail((JSON.parse(plain) as { authorEmail: string }).authorEmail)
};

export const BRANCH_DIGEST: ItemTreeDigest = {
    column: 'name_ref',
    purpose: 'branch',
    within: 'item',
    from: 'content',
    of: (plain) => (JSON.parse(plain) as { name: string }).name
};

export const TAG_DIGEST: ItemTreeDigest = {
    column: 'tag_ref',
    purpose: 'tag',
    within: 'item',
    from: 'content',
    of: (plain) => (JSON.parse(plain) as { tag: string }).tag
};

export function slugRef(keys: ItemDigestKeys, workspaceId: number, owner: string, repo: string): string {
    return itemDigest(keys, SLUG_DIGEST, { workspaceId, itemId: 0 }, comparableSlug(owner, repo));
}

const inRepo = (repoId: number) => ({ workspaceId: 0, itemId: repoId });

export function authorRef(keys: ItemDigestKeys, repoId: number, email: string): string {
    return itemDigest(keys, AUTHOR_DIGEST, inRepo(repoId), comparableEmail(email));
}

export function branchRef(keys: ItemDigestKeys, repoId: number, name: string): string {
    return itemDigest(keys, BRANCH_DIGEST, inRepo(repoId), name);
}

export function tagRef(keys: ItemDigestKeys, repoId: number, tag: string): string {
    return itemDigest(keys, TAG_DIGEST, inRepo(repoId), tag);
}
