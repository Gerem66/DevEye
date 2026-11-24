import { itemDigest, type ItemDigestKeys, type ItemTree, type ItemTreeDigest } from '@deveye/types/sdk/server';

/**
 * Ce qui reconnaît un site d'origine déjà étiqueté dans un espace : le
 * chiffrement étant non déterministe, `content` ne peut porter l'unicité. Lié à
 * l'espace : le même site, vu d'un autre, y a un condensé sans rapport.
 */
const LABEL_DIGEST: ItemTreeDigest = {
    column: 'label_ref',
    purpose: 'label',
    within: 'workspace',
    from: 'content',
    of: (plain) => plain
};

export function labelRef(keys: ItemDigestKeys, workspaceId: number, value: string): string {
    return itemDigest(keys, LABEL_DIGEST, { workspaceId, itemId: 0 }, value);
}

/** Les étiquettes d'un espace, décrites comme un arbre d'une seule table : ce que la reprise des condensés parcourt. */
export const labelsTree: ItemTree = [
    {
        table: 'ft_shortlinks_labels',
        idColumn: 'id',
        ownerColumn: 'id',
        workspaceColumn: 'workspace_id',
        sealed: ['content'],
        digests: [LABEL_DIGEST]
    }
];
