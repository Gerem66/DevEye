import {
    Button,
    FeatureSettingsButton,
    humanizeError,
    invalidate,
    PlanPausedNotice,
    safeHref,
    StatusBadge,
    StickyHeader,
    useResource
} from 'deveye-sdk-client';
import { useState } from 'react';

import type { Shortlink } from '../contracts/domain';
import { api } from './api';
import CopyLink from './CopyLink';
import {
    dayLabel,
    displayTitle,
    formatAgo,
    formatCount,
    hasUtm,
    hostOf,
    momentLabel,
    plural,
    shareUrlOf,
    withUtm
} from './format';
import LinkStatus from './LinkStatus';
import QrDialog from './QrDialog';
import StatsBlock from './StatsBlock';
import styles from './style.module.css';

/**
 * La fiche d'un lien : son identité et ses gestes dans l'en-tête, puis ses
 * chiffres, d'où viennent ses visiteurs, où il mène et l'état de sa
 * destination. Tout réglage vit dans ses réglages, onglets Général, Accès et
 * Campagne.
 */
export default function LinkDetail({
    linkId,
    canWrite,
    onBack
}: {
    linkId: number;
    canWrite: boolean;
    onBack: () => void;
}) {
    const [qrOpen, setQrOpen] = useState(false);
    const read = useResource(
        'shortlinks.get',
        () => api.send('shortlinks.get', { id: linkId }),
        'Ce lien n’a pas pu être lu.',
        [linkId]
    );

    // L'en-tête porte le retour : sans lui, une fiche qui n'a pas pu se charger enfermerait le lecteur.
    if (read.data === null) {
        return (
            <div className={styles.root}>
                <StickyHeader>
                    <header className={styles.header}>
                        <div className={styles.detailHead}>
                            <Button variant='ghost' icon='arrow-left' onClick={onBack}>
                                Liens
                            </Button>
                        </div>
                    </header>
                </StickyHeader>
                {read.error !== null ? (
                    <p className={styles.error}>{read.error}</p>
                ) : (
                    <p className={styles.empty}>Chargement…</p>
                )}
            </div>
        );
    }

    const { link } = read.data;
    const address = shareUrlOf(link);
    const title = displayTitle(link);

    return (
        <div className={styles.root}>
            <StickyHeader>
                <header className={styles.header}>
                    <div className={styles.detailHead}>
                        <Button variant='ghost' icon='arrow-left' onClick={onBack}>
                            Liens
                        </Button>
                        <div className={styles.ident}>
                            <h2 className={styles.identName}>
                                <span className={styles.identTitle}>{title}</span>
                                <LinkStatus link={link} />
                            </h2>
                            <p className={styles.identMeta}>
                                <span className={styles.identAddress}>{address}</span>
                                <span> vers {hostOf(link.targets.default)}</span>
                            </p>
                        </div>
                    </div>
                    <div className={styles.actions}>
                        <CopyLink url={address} />
                        <Button variant='secondary' onClick={() => setQrOpen(true)}>
                            QR code
                        </Button>
                        <Button
                            variant='secondary'
                            icon='arrow'
                            href={safeHref(address)}
                            target='_blank'
                            title='Ouvrir le lien dans un nouvel onglet'
                        >
                            Ouvrir
                        </Button>
                        <FeatureSettingsButton
                            scope={{ kind: 'item', feature: 'shortlinks', itemId: String(link.id), itemLabel: title }}
                            onGone={onBack}
                        />
                    </div>
                </header>
            </StickyHeader>

            <StateNotice link={link} />

            <StatsBlock key={link.id} linkId={link.id} title='Visites' detailed />

            <div className={styles.panels}>
                <Destination link={link} address={address} />
                <TargetCheck link={link} canWrite={canWrite && !link.foreign} />
            </div>

            <QrDialog link={link} open={qrOpen} onClose={() => setQrOpen(false)} />
        </div>
    );
}

/** Pourquoi le lien ne redirige pas, quand c'est le cas, et où le rétablir. */
function StateNotice({ link }: { link: Shortlink }) {
    const scope = {
        kind: 'item' as const,
        feature: 'shortlinks' as const,
        itemId: String(link.id),
        itemLabel: displayTitle(link)
    };
    if (link.status === 'blocked') {
        return (
            <div className={styles.blockedNotice} role='status'>
                <p className={styles.noticeTitle}>Retiré par l’administration du service</p>
                <p>
                    {link.blockedReason ? `Motif : ${link.blockedReason}. ` : ''}
                    Le lien ne redirige plus personne. Ses chiffres restent lisibles ici.
                </p>
            </div>
        );
    }
    if (link.status === 'planPaused') {
        return link.foreign ? null : <PlanPausedNotice count={1} one='lien court' many='liens courts' />;
    }
    if (link.status === 'disabled') {
        return (
            <p className={styles.notice} role='status'>
                Ce lien est en pause : il ne redirige plus personne. Rallumez-le dans ses{' '}
                <FeatureSettingsButton scope={scope} initialSection='general' variant='link' label='réglages' />.
            </p>
        );
    }
    if (link.status === 'expired') {
        return (
            <p className={styles.notice} role='status'>
                Ce lien a expiré : sa date de fin est passée ou ses visites sont épuisées. Repoussez sa fin dans
                l’onglet <FeatureSettingsButton scope={scope} initialSection='access' variant='link' label='Accès' />{' '}
                pour le rouvrir.
            </p>
        );
    }
    return null;
}

/** Où mène le lien, ce qui s'ajoute en chemin, et ce qui en garde l'accès. */
function Destination({ link, address }: { link: Shortlink; address: string }) {
    const utm = hasUtm(link.utm);
    return (
        <section className={styles.panel}>
            <h3 className={styles.panelTitle}>Destination</h3>
            <dl className={styles.facts}>
                <div className={styles.fact}>
                    <dt>{link.targets.ios !== null || link.targets.android !== null ? 'Par défaut' : 'Mène vers'}</dt>
                    <dd>
                        <a
                            className={styles.factUrl}
                            href={safeHref(link.targets.default)}
                            target='_blank'
                            rel='noopener noreferrer'
                        >
                            {link.targets.default}
                        </a>
                    </dd>
                </div>
                {link.targets.ios !== null && (
                    <div className={styles.fact}>
                        <dt>Sur iPhone et iPad</dt>
                        <dd className={styles.factUrl}>{link.targets.ios}</dd>
                    </div>
                )}
                {link.targets.android !== null && (
                    <div className={styles.fact}>
                        <dt>Sur Android</dt>
                        <dd className={styles.factUrl}>{link.targets.android}</dd>
                    </div>
                )}
                {utm && (
                    <div className={styles.fact}>
                        <dt>Avec la campagne</dt>
                        <dd className={styles.factUrl}>{withUtm(link.targets.default, link.utm)}</dd>
                    </div>
                )}
                <div className={styles.fact}>
                    <dt>Adresse de DevEye</dt>
                    <dd className={styles.factUrl}>{link.shortUrl}</dd>
                </div>
                {link.domainHost !== null && (
                    <div className={styles.fact}>
                        <dt>Sur votre domaine</dt>
                        <dd className={link.domainUrl === null ? undefined : styles.factUrl}>
                            {link.domainUrl ??
                                `${link.domainHost} attend sa vérification : seule l’adresse de DevEye répond d’ici là.`}
                        </dd>
                    </div>
                )}
                <div className={styles.fact}>
                    <dt>Accès</dt>
                    <dd>{accessSummary(link)}</dd>
                </div>
            </dl>
            <p className={styles.tip}>
                <span className='icon icon-info' aria-hidden='true' /> Ajoutez + à la fin du lien pour voir où il mène
                sans y aller : <span className={styles.factUrl}>{address}+</span>
            </p>
        </section>
    );
}

function accessSummary(link: Shortlink): string {
    const parts: string[] = [];
    if (link.hasPassword) parts.push('mot de passe demandé');
    if (link.expiresAt !== null) parts.push(`jusqu’au ${dayLabel(link.expiresAt)}`);
    if (link.maxVisits !== null) {
        parts.push(`${plural(link.maxVisits, 'visite', 'visites')} au plus (${formatCount(link.visits)} à ce jour)`);
    }
    if (parts.length === 0) return 'Ouvert à tous, sans limite';
    const text = parts.join(', ');
    return text.charAt(0).toLocaleUpperCase('fr-FR') + text.slice(1);
}

/** La vérification quotidienne de la destination, et le geste pour la refaire tout de suite. */
function TargetCheck({ link, canWrite }: { link: Shortlink; canWrite: boolean }) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const { check } = link;

    const checkNow = async (): Promise<void> => {
        setBusy(true);
        setError(null);
        try {
            await api.send('shortlinks.checkNow', { id: link.id });
            invalidate('shortlinks.list', 'shortlinks.get');
        } catch (failure) {
            setError(humanizeError(failure, 'La vérification n’a pas pu être lancée.'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <section className={styles.panel}>
            <h3 className={styles.panelTitle}>Vérification de la destination</h3>
            {!check.enabled ? (
                <p className={styles.panelText}>
                    La vérification quotidienne est coupée pour ce lien. Elle se rallume dans l’onglet Général de ses
                    réglages.
                </p>
            ) : (
                <>
                    <p className={styles.checkState}>
                        {check.state === 'ok' && <StatusBadge tone='success'>Répond</StatusBadge>}
                        {check.state === 'broken' && <StatusBadge tone='danger'>Injoignable</StatusBadge>}
                        {check.state === 'unknown' && <StatusBadge tone='neutral'>Pas encore vérifiée</StatusBadge>}
                        {check.checkedAt !== null && (
                            <span className={styles.checkWhen} title={momentLabel(check.checkedAt)}>
                                Vérifiée {formatAgo(check.checkedAt)}
                            </span>
                        )}
                    </p>
                    {check.state === 'broken' && check.error !== null && (
                        <p className={styles.panelText}>Raison : {check.error}.</p>
                    )}
                    <p className={styles.panelText}>
                        DevEye ouvre la destination une fois par jour et vous prévient si elle ne répond plus.
                    </p>
                </>
            )}
            {canWrite && (
                <div className={styles.panelActions}>
                    <Button variant='secondary' icon='refresh' disabled={busy} onClick={() => void checkNow()}>
                        {busy ? 'Vérification…' : 'Vérifier maintenant'}
                    </Button>
                </div>
            )}
            {error !== null && <p className={styles.error}>{error}</p>}
        </section>
    );
}
