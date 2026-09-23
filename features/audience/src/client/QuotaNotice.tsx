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

/** À partir d'où l'on prévient : assez tôt pour agir, assez tard pour se taire. */
const WARN_AT = 0.8;

/**
 * Où en sont les vues du mois face à l'offre, et ce qu'on peut y faire.
 *
 * Le compte est dit en permanence, pas seulement une fois la limite atteinte :
 * sans cela on passe sans transition de « tout va bien » à « plus rien n'est
 * mesuré », et un site qui a cessé de compter ressemble à un site que plus
 * personne ne visite.
 */
export default function QuotaNotice({ quota }: { quota: AudienceEventsQuota | null }) {
    const { isOwner } = useWorkspacePermissions();
    if (quota === null) return null;

    const reached = quotaReached(quota);
    const close = !reached && quota.limit > 0 && quota.used >= quota.limit * WARN_AT;
    // En dessous du seuil d'alerte, une ligne discrète suffit : le compte est une
    // information, pas encore un problème.
    if (!reached && !close) {
        return (
            <p className={styles.quotaUsage} role='status'>
                {formatCount(quota.used)} vues et événements sur {formatCount(quota.limit)} ce mois-ci. Le compte repart
                le {nextReset()}.
            </p>
        );
    }

    return (
        <div className={styles.quotaNotice} role='status'>
            <div>
                <p className={styles.quotaTitle}>
                    {reached
                        ? 'Limite de l’offre atteinte : plus rien n’est mesuré'
                        : 'Vous approchez de la limite de votre offre'}
                </p>
                <p>
                    {quota.limit === 0
                        ? 'L’offre de cet espace n’inclut aucune vue.'
                        : `${formatCount(quota.used)} vues et événements sur ${formatCount(quota.limit)} ce mois-ci. Le compte repart le ${nextReset()}.`}{' '}
                    {reached && 'L’historique et les retours de vos formulaires ne sont pas touchés.'}
                    {!isOwner && ' L’offre est celle du propriétaire de l’espace : lui seul peut la changer.'}
                </p>
            </div>
            {isOwner && <Button onClick={() => openAccountView()}>Voir les offres</Button>}
        </div>
    );
}
