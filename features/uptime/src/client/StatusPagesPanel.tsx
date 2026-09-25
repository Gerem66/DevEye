import { useMemo, useState } from 'react';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';
import {
    Button,
    ConfirmDialog,
    copyText,
    humanizeError,
    invalidate,
    openAccountView,
    PlanPausedBadge,
    PlanPausedNotice,
    safeHref,
    settingsStyles as shell,
    StatusBadge,
    useDomains,
    useResource,
    useWorkspacePermissions,
    type ConfirmRequest
} from 'deveye-sdk-client';
import type { UptimePage } from '../contracts/domain';

import { api } from './api';
import StatusPageDialog from './StatusPageDialog';
import styles from './style.module.css';

/**
 * Les pages de statut de l'espace : onglet « Pages de statut » des réglages de
 * la feature. Mêmes rangées que la liste des canaux des Notifications, d'où
 * l'emprunt de `settingsStyles`.
 */
export default function StatusPagesPanel({ canWrite }: SettingsPanelProps) {
    const { data, error: loadError } = useResource(
        'uptime.pageList',
        () => api.send('uptime.pageList', {}),
        'Impossible de charger les pages de statut.'
    );
    const { domains } = useDomains('uptime');
    const { isOwner } = useWorkspacePermissions();
    const [dialog, setDialog] = useState<{ page: UptimePage | null } | null>(null);
    const [copied, setCopied] = useState<{ id: number; ok: boolean } | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

    const pages = data?.pages ?? null;
    // 0 est une limite : l'offre de l'espace n'en permet aucune.
    const closed = data?.limit === 0;
    const planPausedCount = (pages ?? []).filter((page) => page.planPaused).length;
    const hosts = useMemo(() => new Map(domains.map((domain) => [domain.id, domain])), [domains]);
    const takenDomains = useMemo(
        () =>
            new Map(
                (pages ?? [])
                    .filter((page) => page.domainId !== null && page.id !== dialog?.page?.id)
                    .map((page) => [page.domainId as number, page.title])
            ),
        [pages, dialog]
    );

    const changed = () => invalidate('uptime.pageList');

    /* `copyText` du SDK, et jamais `navigator.clipboard`, qui n'existe qu'en
       contexte sécurisé. Son échec se dit sur le bouton. */
    const copy = async (page: UptimePage) => {
        const ok = await copyText(page.url);
        setCopied({ id: page.id, ok });
        window.setTimeout(() => setCopied(null), 2500);
    };

    const askRemove = (page: UptimePage) => {
        setConfirm({
            title: `Supprimer « ${page.title} » ?`,
            description:
                'Son lien cesse aussitôt de répondre, sur l’adresse de DevEye comme sur son domaine. Les services et leur historique ne sont pas touchés.',
            confirmLabel: 'Supprimer la page',
            onConfirm: () =>
                void (async () => {
                    setError(null);
                    try {
                        await api.send('uptime.pageRemove', { id: page.id });
                        changed();
                    } catch (e) {
                        setError(humanizeError(e, 'Impossible de supprimer cette page.'));
                    }
                })()
        });
    };

    /** Ce qui retient la page sur l'adresse de DevEye, s'il y a lieu. */
    const domainNote = (page: UptimePage): string | null => {
        if (page.domainId === null) return null;
        const domain = hosts.get(page.domainId);
        if (!domain) return null;
        return domain.verifiedAt === null
            ? `${domain.host} en attente de vérification : le lien reste sur l’adresse de DevEye`
            : null;
    };

    return (
        <div className={shell.section}>
            <p className={shell.sectionHint}>
                Une page publique, lisible sans compte, qui montre l’état de quelques services et leurs pannes récentes
                : à partager avec vos clients ou vos utilisateurs, sur l’adresse de DevEye ou sur votre propre domaine.
            </p>

            <PlanPausedNotice count={planPausedCount} one='page de statut' many='pages de statut' />
            {/* Des pages en pause : le bandeau commun dit déjà l'offre, et mène aux offres. */}
            {closed && planPausedCount === 0 && (
                <div className={styles.planNotice} role='status'>
                    <p>
                        L’offre de cet espace n’inclut aucune page de statut.
                        {!isOwner && ' L’offre est celle du propriétaire de l’espace : lui seul peut la changer.'}
                    </p>
                    {isOwner && <Button onClick={() => openAccountView()}>Voir les offres</Button>}
                </div>
            )}

            {pages === null && !loadError && <p className={shell.empty}>Chargement…</p>}
            {pages?.length === 0 && !closed && (
                <p className={shell.empty}>
                    {canWrite
                        ? 'Aucune page pour l’instant.'
                        : 'Aucune page. Un membre disposant du droit d’écriture peut en créer une.'}
                </p>
            )}

            <div className={shell.channelList}>
                {(pages ?? []).map((page) => {
                    const note = domainNote(page);
                    const copyState = copied?.id === page.id ? copied.ok : null;
                    return (
                        <div key={page.id} className={shell.channelRow}>
                            <span className={`icon icon-eye-open ${shell.channelIcon}`} aria-hidden='true' />
                            <span className={shell.channelText}>
                                <span className={shell.channelLabel}>
                                    {page.title}
                                    {!page.enabled && <StatusBadge tone='neutral'>non publiée</StatusBadge>}
                                    {page.planPaused && <PlanPausedBadge />}
                                </span>
                                <a
                                    className={`${shell.channelMeta} ${styles.pageLink}`}
                                    href={safeHref(page.url)}
                                    target='_blank'
                                    rel='noopener noreferrer'
                                >
                                    {page.url}
                                </a>
                                <span className={shell.channelMeta}>
                                    {page.services.length} service{page.services.length > 1 ? 's' : ''}
                                </span>
                                {note && <span className={shell.warning}>{note}</span>}
                            </span>
                            <span className={shell.channelActions}>
                                <button
                                    type='button'
                                    className={shell.rowAction}
                                    title={
                                        copyState === null
                                            ? 'Copier le lien'
                                            : copyState
                                              ? 'Lien copié'
                                              : 'Copie impossible : sélectionnez le lien à la main'
                                    }
                                    aria-label={`Copier le lien de ${page.title}`}
                                    onClick={() => void copy(page)}
                                >
                                    <span className={`icon icon-${copyState === true ? 'check-circle' : 'copy'}`} />
                                </button>
                                {canWrite && (
                                    <>
                                        <button
                                            type='button'
                                            className={shell.rowAction}
                                            title='Régler cette page'
                                            aria-label={`Régler ${page.title}`}
                                            onClick={() => setDialog({ page })}
                                        >
                                            <span className='icon icon-edit' />
                                        </button>
                                        <button
                                            type='button'
                                            className={`${shell.rowAction} ${shell.rowActionDanger}`}
                                            title='Supprimer cette page'
                                            aria-label={`Supprimer ${page.title}`}
                                            onClick={() => askRemove(page)}
                                        >
                                            <span className='icon icon-trash' />
                                        </button>
                                    </>
                                )}
                            </span>
                        </div>
                    );
                })}
            </div>

            {(error ?? loadError) && <p className={shell.notice}>{error ?? loadError}</p>}

            {canWrite && !closed && (
                <div className={shell.sectionActions}>
                    <Button variant='secondary' icon='add' onClick={() => setDialog({ page: null })}>
                        Nouvelle page
                    </Button>
                </div>
            )}

            <StatusPageDialog
                open={dialog !== null}
                page={dialog?.page ?? null}
                domains={domains}
                takenDomains={takenDomains}
                onClose={() => setDialog(null)}
                onSaved={changed}
            />

            <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
        </div>
    );
}
