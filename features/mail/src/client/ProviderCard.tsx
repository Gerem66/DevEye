import { Button } from 'deveye-sdk-client';

import { describeAccountStatus } from './accountStatus';
import styles from './style.module.css';

import type { MailAccount } from '../contracts/domain';

/**
 * L'encart d'une boîte gérée par un fournisseur, à la place des champs de
 * serveurs qu'elle n'a pas.
 *
 * Il dit l'état RÉEL de la boîte, pas le seul fait qu'elle soit passée par un
 * consentement un jour : une carte verte « Connecté via Google » sur une boîte
 * dont le fournisseur refuse l'accès est le seul endroit de l'écran à prétendre
 * que tout va bien, et c'est celui où l'on vient chercher quoi faire.
 *
 * `onReconnect` absent : la carte se contente de décrire. C'est le cas dans le
 * formulaire d'ajout, où la boîte vient d'être connectée.
 */
export function ProviderCard({
    account,
    onReconnect,
    busy
}: {
    account: MailAccount;
    onReconnect?: () => void;
    busy?: boolean;
}) {
    const status = describeAccountStatus(account);
    const provider = account.authMethod === 'oauth_google' ? 'Google' : 'Microsoft';
    // Une reconnexion ne répare qu'une impasse d'autorisation : un serveur
    // injoignable revient tout seul, et repasser par le consentement ne ferait
    // qu'ajouter un geste inutile.
    const offerReconnect = onReconnect && (account.needsReauth || account.status === 'auth');

    return (
        <div className={styles.providerCard} data-tone={status?.tone}>
            <span
                className={`icon icon-${status ? 'error' : 'check-circle'} ${styles.providerCardCheck}`}
                aria-hidden='true'
            />
            <span className={styles.providerCardBody}>
                <strong className={styles.providerCardTitle}>
                    {status ? `Connexion ${provider} à renouveler` : `Connecté via ${provider}`}
                </strong>
                <span className={styles.providerCardAddress}>{account.emailAddress}</span>
                <span className={styles.fieldHint}>
                    {status
                        ? status.headline
                        : 'Les identifiants et les serveurs sont gérés par le fournisseur : il n’y a rien à configurer ici.'}
                </span>
                {account.lastSyncError && <span className={styles.fieldHint}>{account.lastSyncError}</span>}
                {offerReconnect && (
                    <span className={styles.providerCardAction}>
                        <Button variant='secondary' disabled={busy} onClick={onReconnect}>
                            {busy ? 'Connexion…' : `Reconnecter à ${provider}`}
                        </Button>
                    </span>
                )}
            </span>
        </div>
    );
}

export default ProviderCard;
