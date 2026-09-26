import { normalizeLabel } from '../../contracts/statement';

/** Ce qu'une banque ajoute à tous ses libellés, et les formes de société : rien qui dise qui a été payé. */
const NOISE = new Set([
    'prlv',
    'prelevement',
    'sepa',
    'carte',
    'vir',
    'virement',
    'inst',
    'instantane',
    'recu',
    'emis',
    'motif',
    'paiement',
    'achat',
    'facture',
    'fact',
    'ref',
    'des',
    'web',
    'www',
    'com',
    'sas',
    'sasu',
    'sarl',
    'eurl',
    'ltd',
    'inc',
    'gmbh'
]);

/**
 * Le mot d'un libellé bancaire qu'une règle retiendrait : le premier qui ne soit
 * ni un mot de banque, ni un nombre. « PRLV SEPA OVH SAS » donne « ovh ». Vide
 * quand rien ne se distingue : la personne l'écrit alors elle-même.
 */
export function ruleKeyword(label: string): string {
    const words = normalizeLabel(label)
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length >= 3 && !/\d/.test(word) && !NOISE.has(word));
    return words[0] ?? '';
}
