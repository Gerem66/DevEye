import { Button, openAccountView, useWorkspacePermissions } from 'deveye-sdk-client';

import type { AudienceEventsQuota } from '../contracts/domain';
import { formatCount, quotaReached } from './format';
import styles from './style.module.css';

/** Le premier du mois prochain, en UTC comme le compte : « 1 octobre ». */
function nextReset(now: Date = new Date()): string {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toLocaleDateString('fr-FR', {
        day: 'numeric',
        month: 'long',
        timeZone: 'UTC'
    });
}

/**
 * Ce qui se passe quand l'offre ne laisse plus rien mesurer, et ce qu'on peut y
 * faire. Sans ce bandeau, un site qui a cessé de compter ressemble à un site que
 * plus personne ne visite.
 */
export default function QuotaNotice({ quota }: { quota: AudienceEventsQuota | null }) {
    const { isOwner } = useWorkspacePermissions();
    if (quota === null || !quotaReached(quota)) return null;
    return (
        <div className={styles.quotaNotice} role='status'>
            <div>
                <p className={styles.quotaTitle}>Limite de l’offre atteinte : plus rien n’est mesuré</p>
                <p>
                    {quota.limit === 0
                        ? 'L’offre de cet espace n’inclut aucune vue.'
                        : `Les ${formatCount(quota.limit)} vues et événements du mois sont atteints. La mesure reprend le ${nextReset()}.`}{' '}
                    L’historique et les retours de vos formulaires ne sont pas touchés.
                    {!isOwner && ' L’offre est celle du propriétaire de l’espace : lui seul peut la changer.'}
                </p>
            </div>
            {isOwner && <Button onClick={() => openAccountView()}>Voir les offres</Button>}
        </div>
    );
}
