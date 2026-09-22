import type { DocumentKind, InvoicingQuotaLine, InvoicingQuotaUsage } from '../contracts/domain';
import styles from './style.module.css';

/**
 * Ce que l'offre permet ce mois-ci, dit **avant** le refus et non à sa place.
 * La phrase vit ici seule, pour que le tableau de bord et la fiche d'un
 * brouillon ne finissent pas par en donner deux versions.
 */

export interface QuotaNoteProps {
    usage: InvoicingQuotaUsage | null;
    /** Sur la fiche d'un brouillon : seule la limite de son type l'intéresse. */
    only?: DocumentKind;
}

const WORDS: Record<'quotes' | 'invoices', { one: string; many: string; none: string }> = {
    quotes: { one: 'devis', many: 'devis', none: 'aucun devis' },
    invoices: { one: 'facture', many: 'factures', none: 'aucune facture' }
};

function line(key: 'quotes' | 'invoices', entry: InvoicingQuotaLine): string {
    const words = WORDS[key];
    if (entry.limit === 0) return `votre offre n’inclut ${words.none}`;
    return `${entry.used} ${entry.used > 1 ? words.many : words.one} sur ${entry.limit}`;
}

export default function QuotaNote({ usage, only }: QuotaNoteProps) {
    if (usage === null) return null;

    const parts: { key: 'quotes' | 'invoices'; entry: InvoicingQuotaLine }[] = [];
    if (usage.quotes !== null && only !== 'invoice' && only !== 'credit') {
        parts.push({ key: 'quotes', entry: usage.quotes });
    }
    if (usage.invoices !== null && only !== 'quote') {
        parts.push({ key: 'invoices', entry: usage.invoices });
    }
    if (parts.length === 0) return null;

    const full = parts.some(({ entry }) => entry.used >= entry.limit);
    const sentence = parts.map(({ key, entry }) => line(key, entry)).join(' · ');

    return <p className={full ? styles.quotaFull : styles.quotaNote}>Émis ce mois-ci : {sentence}.</p>;
}
