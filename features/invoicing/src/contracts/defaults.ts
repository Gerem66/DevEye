import type { InvoicingIssuer, InvoicingSettings, InvoicingWording } from './domain';

/**
 * Les valeurs par défaut vivent ici, pas dans la base : une lecture ne doit
 * jamais écrire, et un espace qui n'a jamais ouvert les réglages doit pouvoir
 * lire les siens. La ligne n'apparaît qu'au premier enregistrement.
 */

export const EMPTY_ISSUER: InvoicingIssuer = {
    legalName: '',
    tradeName: '',
    legalForm: '',
    capital: '',
    address: '',
    postalCode: '',
    city: '',
    country: 'France',
    siret: '',
    vatNumber: '',
    rcs: '',
    email: '',
    phone: '',
    website: '',
    iban: '',
    bic: '',
    insurer: '',
    insuranceScope: '',
    logo: ''
};

/**
 * Les phrases prêtes à l'emploi d'une prestation de services en France. Elles
 * sont là pour être relues et corrigées, pas pour être crues : c'est pour cela
 * qu'elles sont des valeurs de formulaire.
 */
export const DEFAULT_WORDING: InvoicingWording = {
    paymentTerms: 'Paiement par virement à réception de la facture.',
    lateFeeText:
        'Tout retard de paiement entraîne des pénalités au taux d’intérêt légal majoré de 10 points, exigibles sans rappel.',
    recoveryFeeText: 'Indemnité forfaitaire pour frais de recouvrement : 40 €.',
    discountText: 'Pas d’escompte pour paiement anticipé.',
    exemptionText: 'TVA non applicable, article 293 B du CGI.',
    quoteTerms: 'Devis gratuit, valable jusqu’à la date indiquée. Les travaux commencent après votre accord écrit.',
    signatureText: 'Bon pour accord, le ……… à ………',
    footer: ''
};

export const DEFAULT_SETTINGS: InvoicingSettings = {
    currency: 'EUR',
    timeZone: 'Europe/Paris',
    /*
     * Franchise en base, et donc aucun taux. Aucun régime par défaut n'est juste
     * pour tout le monde : le choix est celui de la moindre casse. Imprimer
     * « TVA non applicable » quand on y est assujetti donne une facture à
     * refaire ; facturer une TVA qu'on ne doit pas est une dette envers son
     * client et envers l'État.
     *
     * Ce défaut ne part jamais en silence : l'émission exige l'identité de
     * l'émetteur, donc un passage par les réglages, où la question de la TVA est
     * la deuxième.
     */
    vatRegime: 'exempt',
    defaultVatBp: 0,
    paymentTermsDays: 30,
    quoteValidityDays: 30,
    defaultDepositBp: 0,
    quotePrefix: 'D',
    invoicePrefix: 'F',
    creditPrefix: 'A',
    numberReset: 'yearly',
    numberStart: 1,
    numberPad: 4,
    mailSenderId: null,
    domainId: null,
    issuer: EMPTY_ISSUER,
    wording: DEFAULT_WORDING
};
