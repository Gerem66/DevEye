import { itemDigest, type ItemDigestKeys, type ItemTreeDigest } from '@deveye/types/sdk/server';

import type { StoredSite } from './_shared';

/**
 * Les condensés du module. Le chiffrement n'étant pas déterministe, ce qui doit
 * rester unique ou se retrouver sans être déchiffré (le nom d'un site, d'un
 * entonnoir, d'un formulaire, un libellé mesuré, une réponse comptée) est
 * doublé d'un condensé à clé. Chaque déclaration sert trois fois : la collecte
 * et la saisie calculent par elle, l'arbre de `copy.ts` la porte, et la
 * reprise des lignes existantes la relit.
 *
 * Le nom d'un site est lié à son espace, tout le reste au site : le même chemin
 * mesuré sur deux sites y porte deux condensés sans rapport.
 */

/** Un nom tel qu'il se compare : deux écritures du même nom se confondent. */
const comparableName = (name: string): string => name.trim().toLowerCase();

export const SITE_NAME_DIGEST: ItemTreeDigest = {
    column: 'name_ref',
    purpose: 'site-name',
    within: 'workspace',
    from: 'content',
    of: (plain) => comparableName((JSON.parse(plain) as StoredSite).name)
};

export const FUNNEL_NAME_DIGEST: ItemTreeDigest = {
    column: 'name_ref',
    purpose: 'funnel-name',
    within: 'item',
    from: 'content',
    of: comparableName
};

export const FORM_NAME_DIGEST: ItemTreeDigest = {
    column: 'name_ref',
    purpose: 'form-name',
    within: 'item',
    from: 'content',
    of: comparableName
};

/**
 * Un libellé mesuré (chemin, référent, événement), pris tel quel. L'étape d'un
 * entonnoir porte le même condensé que le libellé qu'elle attend : c'est par
 * lui qu'elle le retrouve.
 */
export const LABEL_DIGEST: ItemTreeDigest = {
    column: 'label_ref',
    purpose: 'label',
    within: 'item',
    from: 'content',
    of: (plain) => plain
};

/** Une question ou une valeur comptée d'un formulaire, prise telle quelle. */
export const FORM_LABEL_DIGEST: ItemTreeDigest = {
    column: 'label_ref',
    purpose: 'form-label',
    within: 'item',
    from: 'content',
    of: (plain) => plain
};

const inSite = (siteId: number) => ({ workspaceId: 0, itemId: siteId });

export function siteNameRef(keys: ItemDigestKeys, workspaceId: number, name: string): string {
    return itemDigest(keys, SITE_NAME_DIGEST, { workspaceId, itemId: 0 }, comparableName(name));
}

export function funnelNameRef(keys: ItemDigestKeys, siteId: number, name: string): string {
    return itemDigest(keys, FUNNEL_NAME_DIGEST, inSite(siteId), comparableName(name));
}

export function formNameRef(keys: ItemDigestKeys, siteId: number, name: string): string {
    return itemDigest(keys, FORM_NAME_DIGEST, inSite(siteId), comparableName(name));
}

export function labelRef(keys: ItemDigestKeys, siteId: number, value: string): string {
    return itemDigest(keys, LABEL_DIGEST, inSite(siteId), value);
}

export function formLabelRef(keys: ItemDigestKeys, siteId: number, value: string): string {
    return itemDigest(keys, FORM_LABEL_DIGEST, inSite(siteId), value);
}
