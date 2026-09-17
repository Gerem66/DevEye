import { useState } from 'react';
import { Button, Dialog } from 'deveye-sdk-client';

import styles from './style.module.css';

/** Un secret montré une seule fois : le serveur n'en garde que le hachage, il ne pourra pas le redire. */
export default function SecretOnceDialog({
    secret,
    title,
    address,
    onClose
}: {
    secret: string | null;
    title: string;
    address: string;
    onClose: () => void;
}) {
    const [copied, setCopied] = useState(false);
    if (secret === null) return null;

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(secret);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 2000);
        } catch {
            setCopied(false);
        }
    };

    return (
        <Dialog
            open
            onClose={onClose}
            title={title}
            description={`Pour ${address}. Notez-le maintenant : il ne sera plus jamais affiché.`}
            width={460}
            dismissible={false}
            footer={<Button onClick={onClose}>C’est noté</Button>}
        >
            <div className={styles.secretRow}>
                <code className={styles.secret}>{secret}</code>
                <Button variant='secondary' icon={copied ? 'check' : 'copy'} onClick={() => void copy()}>
                    {copied ? 'Copié' : 'Copier'}
                </Button>
            </div>
            <p className={styles.hint}>
                DevEye n’en conserve qu’une empreinte. En cas d’oubli, réinitialisez-le depuis les réglages de
                l’adresse.
            </p>
        </Dialog>
    );
}
