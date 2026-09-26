/** Les pages légales du site vitrine, aux adresses que le site sert. */
export interface LegalLinks {
    notice: string;
    terms: string;
    sales: string;
    privacy: string;
}

export const LEGAL_LABELS: Record<keyof LegalLinks, string> = {
    notice: 'Mentions légales',
    terms: 'Conditions d’utilisation',
    sales: 'Conditions de vente',
    privacy: 'Politique de confidentialité'
};

export function legalLinks(siteUrl: string): LegalLinks {
    const base = siteUrl.replace(/\/+$/, '');
    return {
        notice: `${base}/mentions-legales`,
        terms: `${base}/cgu`,
        sales: `${base}/cgv`,
        privacy: `${base}/confidentialite`
    };
}
