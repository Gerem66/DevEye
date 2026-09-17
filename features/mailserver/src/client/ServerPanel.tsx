import { StatusBadge, settingsStyles as shell, useResource } from 'deveye-sdk-client';

import type { ListenerState } from '../contracts/domain';
import { api } from './api';
import styles from './style.module.css';

const LISTENER_LABEL: Record<ListenerState['name'], string> = {
    smtp: 'Réception du courrier (SMTP)',
    submissions: 'Envoi par un client, TLS direct',
    submission: 'Envoi par un client, STARTTLS',
    imaps: 'Lecture par un client (IMAP)'
};

/** L'état du serveur, qui appartient à l'installation : un seul jeu d'écouteurs sert tous les espaces. */
export default function ServerPanel() {
    const { data, error } = useResource(
        'mailserver.serverStatus',
        () => api.send('mailserver.serverStatus', {}).then((res) => res.status),
        'L’état du serveur n’a pas pu être lu.'
    );

    if (error) return <p className={shell.errorText}>{error}</p>;
    if (!data) return <p className={shell.sectionHint}>Chargement…</p>;

    if (!data.configured) {
        return (
            <div className={shell.section}>
                <p className={`${shell.sectionHint} ${shell.panelLead}`}>
                    Le serveur mail n’a pas encore de nom d’hôte : rien n’écoute, aucune adresse ne reçoit ni n’envoie.
                </p>
                <p className={shell.sectionHint}>
                    L’administrateur de l’installation pose <code>MAILSERVER_HOSTNAME</code> (par exemple{' '}
                    <code>mail.exemple.fr</code>), publie les ports 25, 465, 587 et 993, puis redémarre DevEye. Les
                    domaines et les adresses peuvent déjà être préparés.
                </p>
            </div>
        );
    }

    const certificate = data.certificate;
    const expiresIn = certificate ? Math.floor((certificate.notAfter - Date.now() / 1000) / 86_400) : 0;

    return (
        <div className={shell.section}>
            <p className={`${shell.sectionHint} ${shell.panelLead}`}>
                Le serveur est celui de l’installation : il sert tous les espaces. Chaque espace n’y déclare que ses
                domaines et ses adresses.
            </p>

            <div className={shell.field}>
                <span className={shell.fieldLabel}>Nom du serveur</span>
                <code className={styles.factValue}>{data.hostname}</code>
                <span className={shell.fieldHint}>C’est lui que le MX de chaque domaine doit viser.</span>
            </div>

            <div className={shell.section}>
                <span className={shell.sectionLabel}>Ports</span>
                <div className={shell.channelList}>
                    {data.listeners.map((listener) => (
                        <div key={listener.name} className={shell.channelRow}>
                            <span className={shell.channelText}>
                                <span className={shell.channelLabel}>
                                    {LISTENER_LABEL[listener.name]}
                                    <StatusBadge tone={listener.up ? 'success' : 'warning'}>
                                        {listener.up ? 'Ouvert' : 'Fermé'}
                                    </StatusBadge>
                                </span>
                                <span className={shell.channelMeta}>
                                    Port {listener.port}
                                    {listener.reason && ` · ${listener.reason}`}
                                </span>
                            </span>
                        </div>
                    ))}
                </div>
            </div>

            <div className={shell.section}>
                <span className={shell.sectionLabel}>Certificat</span>
                {certificate ? (
                    <p className={shell.sectionHint}>
                        {certificate.source === 'acme' ? 'Obtenu chez Let’s Encrypt' : 'Fourni par l’installation'},
                        valable encore {expiresIn} jour{expiresIn > 1 ? 's' : ''}.
                        {certificate.source === 'acme' && ' Il se renouvelle tout seul.'}
                        {certificate.staging && ' Certificat d’essai : les clients le refuseront.'}
                    </p>
                ) : (
                    <p className={shell.sectionHint}>
                        Aucun pour l’instant. Sans lui, seul le port 25 écoute, sans chiffrement.
                    </p>
                )}
                {data.certificateError && <p className={shell.errorText}>{data.certificateError}</p>}
            </div>

            <div className={shell.field}>
                <span className={shell.fieldLabel}>File d’envoi</span>
                <span className={shell.sectionHint}>
                    {data.queueDepth === 0
                        ? 'Vide : tout ce qui devait partir est parti.'
                        : `${data.queueDepth} message(s) en attente de remise, tous espaces confondus.`}
                </span>
            </div>
        </div>
    );
}
