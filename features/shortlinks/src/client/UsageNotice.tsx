import { Button, openAccountView, useWorkspacePermissions } from 'deveye-sdk-client';

import type { ShortlinkUsage } from '../contracts/domain';
import { formatCount, nextReset, plural } from './format';
import styles from './style.module.css';

/** À partir d'où l'on prévient : assez tôt pour agir, assez tard pour se taire. */
const WARN_AT = 0.8;

interface Bounded {
    key: 'links' | 'visits';
    used: number;
    limit: number;
    text: string;
}

/**
 * Où en sont les liens et les visites du mois face à l'offre. Le compte se dit
 * en permanence : celui qui se heurte à la limite des visites n'est pas le
 * titulaire du compte, c'est la personne qui suit le lien.
 */
export default function UsageNotice({ usage }: { usage: ShortlinkUsage | null }) {
    const { isOwner } = useWorkspacePermissions();
    if (usage === null) return null;

    const bounded: Bounded[] = [];
    if (usage.links !== null && usage.links.limit !== null) {
        const { used, limit } = usage.links;
        bounded.push({ key: 'links', used, limit, text: `${plural(used, 'lien', 'liens')} sur ${formatCount(limit)}` });
    }
    if (usage.visits !== null && usage.visits.limit !== null) {
        const { used, limit } = usage.visits;
        bounded.push({
            key: 'visits',
            used,
            limit,
            text: `${plural(used, 'visite', 'visites')} sur ${formatCount(limit)} ce mois-ci`
        });
    }
    if (bounded.length === 0) return null;

    const reached = bounded.filter((entry) => entry.used >= entry.limit);
    const close = bounded.filter((entry) => entry.used < entry.limit && entry.used >= entry.limit * WARN_AT);
    const counts = `${bounded.map((entry) => entry.text).join(', ')}.`;
    const reset = bounded.some((entry) => entry.key === 'visits')
        ? ` Le compte des visites repart le ${nextReset()}.`
        : '';

    if (reached.length === 0 && close.length === 0) {
        return (
            <p className={styles.quotaUsage} role='status'>
                {counts}
                {reset}
            </p>
        );
    }

    const visitsReached = reached.some((entry) => entry.key === 'visits');
    const linksReached = reached.some((entry) => entry.key === 'links');
    return (
        <div className={visitsReached ? styles.quotaReached : styles.quotaNotice} role='status'>
            <div>
                <p className={styles.quotaTitle}>
                    {visitsReached
                        ? 'Limite des visites atteinte : vos liens sont momentanément indisponibles'
                        : linksReached
                          ? 'Limite de liens atteinte'
                          : 'Vous approchez de la limite de votre offre'}
                </p>
                <p>
                    {counts}
                    {reset}
                    {visitsReached &&
                        ' D’ici là, qui suit un lien voit une page « momentanément indisponible ». Rien n’est supprimé.'}
                    {linksReached && !visitsReached && ' Pour en créer un autre, supprimez-en un ou changez d’offre.'}
                    {!isOwner && ' L’offre est celle du propriétaire de l’espace : lui seul peut la changer.'}
                </p>
            </div>
            {isOwner && <Button onClick={() => openAccountView()}>Voir les offres</Button>}
        </div>
    );
}
