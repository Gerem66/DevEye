import type { MailSecurityTier } from '../contracts/domain';

/**
 * Le palier d'une boîte, défini une fois pour les deux surfaces qui le
 * proposent : le formulaire de création et l'onglet Chiffrement des réglages.
 */
export const SECURITY_TIER_LABEL: Record<MailSecurityTier, string> = {
    open: 'Ouvert',
    guarded: 'Protégé'
};

export const SECURITY_TIER_HINT: Record<MailSecurityTier, string> = {
    open: 'Synchro automatique en tâche de fond, utilisable pour les notifications (ex. Uptime).',
    guarded: 'Nécessite le déverrouillage par mot de passe à chaque consultation ; jamais synchronisé seul.'
};

/** Les deux paliers, dans l'ordre du choix, pour un `SegmentedControl`. */
export const SECURITY_TIER_OPTIONS: readonly { value: MailSecurityTier; label: string; title: string }[] = (
    ['open', 'guarded'] as const
).map((tier) => ({ value: tier, label: SECURITY_TIER_LABEL[tier], title: SECURITY_TIER_HINT[tier] }));
