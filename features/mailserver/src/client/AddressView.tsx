import { useState } from 'react';
import {
    Button,
    copyText,
    FeatureSettingsButton,
    SegmentedControl,
    StatusBadge,
    formatBytesFr,
    humanizeError,
    invalidate,
    PlanPausedBadge,
    useResource,
    useWorkspacePermissions
} from 'deveye-sdk-client';

import type { Connection, Mailbox } from '../contracts/domain';
import ActivityChart from './ActivityChart';
import { api } from './api';
import { EVENT_LABEL, EVENT_TONE, VERDICT_LABEL, ago, clock } from './format';
import MailsBanner from './MailsBanner';
import { useMailsLink } from './useMailsLink';
import styles from './style.module.css';

type Days = '7' | '30' | '90';

function CopyValue({ label, value }: { label: string; value: string }) {
    const [copied, setCopied] = useState(false);
    return (
        <div className={styles.factRow}>
            <span className={styles.factLabel}>{label}</span>
            <code className={styles.factValue}>{value}</code>
            <button
                type='button'
                className={styles.copyBtn}
                title={copied ? 'Copié' : `Copier ${label.toLowerCase()}`}
                aria-label={`Copier ${label.toLowerCase()}`}
                onClick={() => {
                    void copyText(value).then((ok) => {
                        if (!ok) return;
                        setCopied(true);
                        window.setTimeout(() => setCopied(false), 2000);
                    });
                }}
            >
                <span className={`icon icon-${copied ? 'check' : 'copy'}`} />
            </button>
        </div>
    );
}

/** Une adresse ouverte : ce qu'elle reçoit et envoie, où elle en est de sa place, comment s'y connecter. */
export default function AddressView({
    mailbox,
    connection,
    onBack
}: {
    mailbox: Mailbox;
    connection: Connection | null;
    onBack: () => void;
}) {
    const permissions = useWorkspacePermissions();
    const itemId = String(mailbox.id);
    const canWrite = permissions.canFeature('mailserver', 'write', itemId) && !mailbox.foreign;
    const canPasswords = canWrite && permissions.canExtra('mailserver', 'managePasswords', itemId);
    const link = useMailsLink(mailbox, connection);
    const [days, setDays] = useState<Days>('30');
    const [error, setError] = useState<string | null>(null);

    const { data: activity, error: activityError } = useResource(
        'mailserver.activity',
        () => api.send('mailserver.activity', { id: mailbox.id, days: Number(days) as 7 | 30 | 90 }),
        'L’activité n’a pas pu être lue.',
        [mailbox.id, days]
    );

    const dismiss = () => {
        api.send('mailserver.setBanner', { id: mailbox.id, dismissed: true })
            .then(() => invalidate('mailserver.get', 'mailserver.list'))
            .catch((failure: unknown) => setError(humanizeError(failure, 'La proposition n’a pas pu être fermée.')));
    };

    const used = Math.min(1, mailbox.usedBytes / Math.max(1, mailbox.quotaMb * 1024 * 1024));
    const showBanner = link.available && link.linkedId === null && !mailbox.bannerDismissed && !mailbox.foreign;

    return (
        <div className={styles.root}>
            <header className={styles.header}>
                <div className={styles.identity}>
                    <Button variant='ghost' icon='arrow-left' onClick={onBack}>
                        Adresses
                    </Button>
                    <div>
                        <h2 className={styles.heading}>{mailbox.address}</h2>
                        <p className={styles.subheading}>
                            {mailbox.displayName || 'Sans nom affiché'}
                            {mailbox.foreign && ' · vue depuis un autre espace'}
                        </p>
                    </div>
                    {/* En pause, elle ne sert pas : « Active » serait faux, « Éteinte » reste vrai. */}
                    {(!mailbox.enabled || !mailbox.planPaused) && (
                        <StatusBadge tone={mailbox.enabled ? 'success' : 'neutral'}>
                            {mailbox.enabled ? 'Active' : 'Éteinte'}
                        </StatusBadge>
                    )}
                    {mailbox.planPaused && <PlanPausedBadge />}
                </div>
                <div className={styles.actions}>
                    {typeof link.linkedId === 'number' && (
                        <Button variant='secondary' icon='mail' onClick={link.open}>
                            Ouvrir dans Mails
                        </Button>
                    )}
                    <FeatureSettingsButton
                        scope={{
                            kind: 'item',
                            feature: 'mailserver',
                            itemId,
                            itemLabel: mailbox.address,
                            shareable: true
                        }}
                        onGone={onBack}
                    />
                </div>
            </header>

            {showBanner && <MailsBanner link={link} canAdd={canPasswords} onDismiss={canWrite ? dismiss : null} />}
            {error && <p className={styles.error}>{error}</p>}

            <div className={styles.columns}>
                <section className={styles.panel}>
                    <h3 className={styles.panelTitle}>Stockage</h3>
                    <div
                        className={styles.gauge}
                        role='meter'
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(used * 100)}
                    >
                        <span className={styles.gaugeFill} data-full={used > 0.9} style={{ width: `${used * 100}%` }} />
                    </div>
                    <p className={styles.gaugeText}>
                        {formatBytesFr(mailbox.usedBytes)} sur {formatBytesFr(mailbox.quotaMb * 1024 * 1024)} ·{' '}
                        {mailbox.messageCount} message{mailbox.messageCount > 1 ? 's' : ''}
                    </p>
                    <dl className={styles.facts}>
                        <div className={styles.factRow}>
                            <dt className={styles.factLabel}>Dernier message reçu</dt>
                            <dd className={styles.factPlain}>{ago(mailbox.lastDeliveryAt)}</dd>
                        </div>
                        <div className={styles.factRow}>
                            <dt className={styles.factLabel}>Dernière connexion d’un client</dt>
                            <dd className={styles.factPlain}>{ago(mailbox.lastLoginAt)}</dd>
                        </div>
                        <div className={styles.factRow}>
                            <dt className={styles.factLabel}>Envois autorisés par jour</dt>
                            <dd className={styles.factPlain}>{mailbox.outboundDailyLimit}</dd>
                        </div>
                    </dl>
                </section>

                <section className={styles.panel}>
                    <h3 className={styles.panelTitle}>Connexion d’un client de messagerie</h3>
                    {connection ? (
                        <div className={styles.facts}>
                            <CopyValue label='Serveur' value={connection.host} />
                            <CopyValue label='Identifiant' value={mailbox.address} />
                            <CopyValue label='IMAP (TLS)' value={String(connection.imapPort)} />
                            <CopyValue label='SMTP (TLS)' value={String(connection.smtpPort)} />
                            <CopyValue label='SMTP (STARTTLS)' value={String(connection.submissionPort)} />
                        </div>
                    ) : (
                        <p className={styles.hint}>
                            Le serveur n’a pas encore de nom d’hôte : aucun client ne peut s’y connecter. Voir les
                            réglages de la fonctionnalité.
                        </p>
                    )}
                </section>
            </div>

            <section className={styles.panel}>
                <div className={styles.panelHead}>
                    <h3 className={styles.panelTitle}>Activité</h3>
                    <SegmentedControl<Days>
                        value={days}
                        onChange={setDays}
                        options={[
                            { value: '7', label: '7 jours' },
                            { value: '30', label: '30 jours' },
                            { value: '90', label: '90 jours' }
                        ]}
                    />
                </div>
                {activityError && <p className={styles.error}>{activityError}</p>}
                {activity && (
                    <>
                        <div className={styles.totals}>
                            <div className={styles.total}>
                                <span className={styles.totalValue}>{activity.totals.received}</span>
                                <span className={styles.totalLabel}>reçus</span>
                            </div>
                            <div className={styles.total}>
                                <span className={styles.totalValue}>{activity.totals.sent}</span>
                                <span className={styles.totalLabel}>envoyés</span>
                            </div>
                            <div className={styles.total}>
                                <span className={styles.totalValue}>{activity.totals.rejected}</span>
                                <span className={styles.totalLabel}>refusés</span>
                            </div>
                            <div className={styles.total}>
                                <span className={styles.totalValue}>{activity.totals.bounced}</span>
                                <span className={styles.totalLabel}>non remis</span>
                            </div>
                            <div className={styles.total}>
                                <span className={styles.totalValue}>{activity.queued + activity.deferred}</span>
                                <span className={styles.totalLabel}>
                                    en file{activity.deferred > 0 ? `, dont ${activity.deferred} reporté(s)` : ''}
                                </span>
                            </div>
                        </div>
                        <ActivityChart daily={activity.daily} />

                        <h4 className={styles.tableTitle}>Derniers faits</h4>
                        {activity.recent.length === 0 ? (
                            <p className={styles.hint}>Rien encore : ni courrier, ni connexion.</p>
                        ) : (
                            <div className={styles.tableWrap}>
                                <table className={styles.table}>
                                    <thead>
                                        <tr>
                                            <th>Quand</th>
                                            <th>Quoi</th>
                                            <th>Avec qui</th>
                                            <th title='L’expéditeur est-il autorisé par son domaine ?'>SPF</th>
                                            <th title='Le message porte-t-il une signature valable ?'>DKIM</th>
                                            <th title='Le domaine affiché est-il bien celui qui a envoyé ?'>DMARC</th>
                                            <th>Taille</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {activity.recent.map((event) => (
                                            <tr key={event.id} title={event.detail}>
                                                <td>{clock(event.ts)}</td>
                                                <td>
                                                    <StatusBadge tone={EVENT_TONE[event.kind]}>
                                                        {EVENT_LABEL[event.kind]}
                                                    </StatusBadge>
                                                </td>
                                                <td className={styles.peer}>{event.peer}</td>
                                                <td data-verdict={event.spf}>{VERDICT_LABEL[event.spf]}</td>
                                                <td data-verdict={event.dkim}>{VERDICT_LABEL[event.dkim]}</td>
                                                <td data-verdict={event.dmarc}>{VERDICT_LABEL[event.dmarc]}</td>
                                                <td>{event.size > 0 ? formatBytesFr(event.size) : ''}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </>
                )}
            </section>

            {link.dialog}
        </div>
    );
}
