import { Button } from 'deveye-sdk-client';

import type { MailsLink } from './useMailsLink';
import styles from './style.module.css';

/**
 * La proposition « lire cette adresse dans Mails ». Elle ne s'affiche que si
 * elle mène quelque part (Mails installé, adresse pas encore chez lui), et se
 * ferme pour de bon : le réglage reste dans l'onglet Général de l'adresse.
 */
export default function MailsBanner({
    link,
    canAdd,
    onDismiss
}: {
    link: MailsLink;
    canAdd: boolean;
    onDismiss: (() => void) | null;
}) {
    return (
        <div className={styles.banner} role='status'>
            <span className={`icon icon-mail ${styles.bannerIcon}`} aria-hidden='true' />
            <div className={styles.bannerText}>
                <span className={styles.bannerTitle}>Lire cette adresse dans Mails</span>
                <span className={styles.bannerHint}>
                    DevEye l’ajoute comme un compte de Mails, avec un mot de passe qui lui est réservé.
                </span>
                {link.error && <span className={styles.error}>{link.error}</span>}
            </div>
            <div className={styles.bannerActions}>
                {canAdd && (
                    <Button icon='add' disabled={link.busy} onClick={link.add}>
                        Ajouter à Mails
                    </Button>
                )}
                {onDismiss && (
                    <button
                        type='button'
                        className={styles.bannerClose}
                        title='Ne plus proposer pour cette adresse'
                        aria-label='Ne plus proposer pour cette adresse'
                        onClick={onDismiss}
                    >
                        <span className='icon icon-x' />
                    </button>
                )}
            </div>
        </div>
    );
}
