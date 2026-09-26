import { Button, openAccountView, useWorkspacePermissions } from 'deveye-sdk-client';

import type { OsintUsage } from '../contracts/domain';
import styles from './Osint.module.css';

/** Le premier du mois prochain, en UTC comme le compte : « 1 octobre ». */
export function nextReset(now: Date = new Date()): string {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toLocaleDateString('fr-FR', {
        day: 'numeric',
        month: 'long',
        timeZone: 'UTC'
    });
}

/** « 3 recherches sur 20 ce mois-ci » : la phrase que la vue, le widget et les réglages partagent. */
export function usageSentence(usage: OsintUsage): string {
    if (usage.limit === 0) return 'L’offre de cet espace n’inclut aucune recherche.';
    return `${usage.used} recherche${usage.used > 1 ? 's' : ''} sur ${usage.limit} ce mois-ci.`;
}

/** À partir d'où l'on prévient : assez tôt pour agir, assez tard pour se taire. */
const WARN_AT = 0.8;

/**
 * Où en sont les recherches du mois face à l'offre, dit avant le refus et non
 * à sa place. Relancer une carte ne compte pas, rejouer une recherche de
 * l'historique si : la phrase le dit une fois la limite en vue.
 */
export default function QuotaNotice({ usage }: { usage: OsintUsage | null }) {
    const { isOwner } = useWorkspacePermissions();
    if (usage === null) return null;

    const reached = usage.used >= usage.limit;
    const close = !reached && usage.used >= usage.limit * WARN_AT;
    if (!reached && !close) {
        return (
            <p className={styles.quotaUsage} role='status'>
                {usageSentence(usage)} Le compte repart le {nextReset()}.
            </p>
        );
    }

    return (
        <div className={styles.quotaNotice} role='status'>
            <div>
                <p className={styles.quotaTitle}>
                    {reached ? 'Limite de l’offre atteinte ce mois-ci' : 'Vous approchez de la limite de votre offre'}
                </p>
                <p>
                    {usageSentence(usage)} {usage.limit > 0 && `Le compte repart le ${nextReset()}. `}
                    Une recherche rejouée depuis l’historique compte, relancer une carte non.
                    {!isOwner && ' L’offre est celle du propriétaire de l’espace : lui seul peut la changer.'}
                </p>
            </div>
            {isOwner && <Button onClick={() => openAccountView()}>Voir les offres</Button>}
        </div>
    );
}
