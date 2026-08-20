import { useCallback, useEffect, useState } from 'react';
import type { BackupDestination, BackupDestinationProbe } from 'deveye-types';

import Button from '@/Components/Button';
import { ConfirmDialog, type ConfirmRequest } from '@/Components/ConfirmDialog';
import { ws } from '@/api/ws';
import { invalidate, useResourceVersion } from '@/stores/invalidation';
import { useWorkspacePermissions } from '@/stores/workspace';
import DestinationDialog from './DestinationDialog';
import {
    backupError,
    BACKUP_PROBE_TIMEOUT_MS,
    DESTINATION_ICONS,
    DESTINATION_LABELS,
    destinationTone,
    formatAgo,
    formatBytes
} from './format';
import shell from '@/Components/FeatureSettings/FeatureSettings.module.css';
import styles from './style.module.css';

/**
 * Les destinations de l'espace : le panneau de l'onglet « Sources » des
 * réglages de la feature Sauvegardes.
 *
 * C'était un dialogue à part, derrière son propre bouton « Destinations » en
 * tête de la feature : un endroit de plus à connaître, à côté des réglages. Les
 * sources d'une fonctionnalité vivent désormais toutes au même endroit,
 * Réglages → Sources, et le « + » du dialogue de travail mène ici.
 *
 * Rangées, dialogue d'ajout empilé et confirmation : les mêmes formes que la
 * liste des canaux de la section Notifications, exprès. C'est la rangée
 * canonique des réglages, d'où l'emprunt de sa feuille (`shell`) ; seule la
 * pastille d'état reste celle de la feature, qui la partage avec ses cartes.
 *
 * Autonome exprès : il se charge (`backup.destinationList`), s'invalide et se
 * rafraîchit tout seul, condition pour que la coquille de réglages n'ait rien à
 * savoir de lui. Importe ses composants par chemins directs, jamais par le
 * baril `@/Components` : il réexporte la coquille, ce serait un cycle.
 */
export function DestinationsSection() {
    const permissions = useWorkspacePermissions();
    const canWrite = permissions.canFeature('backup', 'write');
    const listVersion = useResourceVersion('backup.destinationList');

    const [destinations, setDestinations] = useState<BackupDestination[] | null>(null);
    const [dialog, setDialog] = useState<{ destination: BackupDestination | null } | null>(null);
    const [testing, setTesting] = useState<number | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
    /**
     * Ce que le dernier contrôle a mesuré, par destination.
     *
     * En mémoire de l'écran seulement, pas en base : l'occupation d'un bucket
     * change à chaque sauvegarde, et la ranger en base voudrait dire l'y écrire
     * à chaque passage, donc afficher, le reste du temps, un chiffre faux avec
     * l'autorité d'une donnée enregistrée. Elle n'a de sens qu'au moment où on
     * vient de la mesurer.
     */
    const [probes, setProbes] = useState<Record<number, BackupDestinationProbe>>({});

    const reload = useCallback(async () => {
        try {
            const res = await ws.send('backup.destinationList', {});
            setDestinations(res.destinations);
        } catch (e) {
            setDestinations([]);
            setError(backupError(e, 'Impossible de charger les destinations.'));
        }
    }, []);

    useEffect(() => {
        void reload();
    }, [reload, listVersion]);

    /**
     * Une destination qui change touche aussi les travaux (nom affiché sur
     * chaque carte, verdict de contrôle) et la tuile de l'accueil : les mêmes
     * clés que la feature invalidait quand ce panneau était son dialogue.
     */
    const changed = () => invalidate('backup.destinationList', 'backup.jobList', 'backup.count');

    const test = async (destination: BackupDestination) => {
        setTesting(destination.id);
        setError(null);
        try {
            const probe = await ws.send(
                'backup.destinationTest',
                { destinationId: destination.id },
                { timeoutMs: BACKUP_PROBE_TIMEOUT_MS }
            );
            setProbes((prev) => ({ ...prev, [destination.id]: probe }));
            if (!probe.ok) setError(probe.error ?? 'Le contrôle a échoué.');
            changed();
        } catch (e) {
            setError(backupError(e, 'Le contrôle n’a pas abouti.'));
        } finally {
            setTesting(null);
        }
    };

    /**
     * La confirmation ne s'ouvre que quand le retrait est possible : une
     * destination encore désignée a son bouton désactivé, avec la raison.
     */
    const askRemove = (destination: BackupDestination) => {
        setConfirm({
            title: `Retirer « ${destination.name} » ?`,
            description:
                'Les archives déjà écrites ne sont pas touchées : DevEye ne détruit rien chez vous en rangeant sa configuration.',
            confirmLabel: 'Retirer la destination',
            onConfirm: () =>
                void (async () => {
                    setError(null);
                    try {
                        await ws.send('backup.destinationRemove', { destinationId: destination.id });
                        changed();
                    } catch (e) {
                        setError(backupError(e, 'Impossible de retirer cette destination.'));
                    }
                })()
        });
    };

    return (
        <div className={shell.section}>
            {destinations === null && <p className={shell.empty}>Chargement…</p>}
            {destinations?.length === 0 && (
                <p className={shell.empty}>
                    {canWrite
                        ? 'Aucune destination. Déclarez-en une pour pouvoir programmer une sauvegarde.'
                        : 'Aucune destination. Un membre disposant du droit d’écriture peut en déclarer une.'}
                </p>
            )}

            <div className={shell.channelList}>
                {(destinations ?? []).map((destination) => {
                    const probe = probes[destination.id];
                    const busyHere = testing === destination.id;
                    return (
                        <div key={destination.id} className={shell.channelRow}>
                            <span
                                className={`icon icon-${DESTINATION_ICONS[destination.kind]} ${shell.channelIcon}`}
                                aria-hidden='true'
                            />
                            <span className={shell.channelText}>
                                <span className={shell.channelLabel}>
                                    <span
                                        className={styles.statusDot}
                                        data-tone={destinationTone(destination.status)}
                                        aria-hidden='true'
                                    />
                                    {destination.name}
                                </span>
                                <span className={shell.channelMeta}>
                                    {DESTINATION_LABELS[destination.kind]}
                                    {destination.kind === 'device' && destination.deviceName
                                        ? ` · ${destination.deviceName}`
                                        : ''}
                                    {destination.kind === 's3' && destination.bucket ? ` · ${destination.bucket}` : ''}
                                    {destination.path ? ` · ${destination.path}` : ''}
                                    {destination.encrypt ? ' · chiffrée' : ''}
                                </span>
                                <span className={shell.channelMeta}>
                                    {destination.status === 'unknown'
                                        ? 'Jamais contrôlée'
                                        : `Contrôlée ${formatAgo(destination.checkedAt)}`}
                                    {probe?.ok && probe.usedBytes !== null
                                        ? ` · ${formatBytes(probe.usedBytes ?? 0)} occupés`
                                        : ''}
                                    {probe?.ok && probe.freeBytes !== null
                                        ? ` · ${formatBytes(probe.freeBytes ?? 0)} libres`
                                        : ''}
                                </span>
                                {destination.lastError && (
                                    <span className={shell.errorText}>{destination.lastError}</span>
                                )}
                            </span>
                            <span
                                className={`${shell.channelUsage} ${destination.jobCount === 0 ? shell.channelUsageIdle : ''}`}
                                title={
                                    destination.jobCount === 0
                                        ? 'Aucun travail n’écrit ici'
                                        : `${destination.jobCount} tra${destination.jobCount > 1 ? 'vaux écrivent' : 'vail écrit'} ici`
                                }
                            >
                                {destination.jobCount === 0 ? 'inutilisée' : `${destination.jobCount}×`}
                            </span>
                            {canWrite && (
                                <span className={shell.channelActions}>
                                    <button
                                        type='button'
                                        className={shell.rowAction}
                                        title='Contrôler cette destination (écrit, relit et efface un objet témoin)'
                                        aria-label={`Contrôler ${destination.name}`}
                                        disabled={testing !== null}
                                        onClick={() => void test(destination)}
                                    >
                                        <span className={`icon icon-${busyHere ? 'spinner' : 'play'}`} />
                                    </button>
                                    <button
                                        type='button'
                                        className={shell.rowAction}
                                        title='Modifier cette destination'
                                        aria-label={`Modifier ${destination.name}`}
                                        disabled={testing !== null}
                                        onClick={() => setDialog({ destination })}
                                    >
                                        <span className='icon icon-edit' />
                                    </button>
                                    <button
                                        type='button'
                                        className={`${shell.rowAction} ${shell.rowActionDanger}`}
                                        title={
                                            destination.jobCount > 0
                                                ? `${destination.jobCount} tra${destination.jobCount > 1 ? 'vaux écrivent' : 'vail écrit'} encore ici : changez leur destination d’abord.`
                                                : 'Retirer cette destination'
                                        }
                                        aria-label={`Retirer ${destination.name}`}
                                        disabled={testing !== null || destination.jobCount > 0}
                                        onClick={() => askRemove(destination)}
                                    >
                                        <span className='icon icon-trash' />
                                    </button>
                                </span>
                            )}
                        </div>
                    );
                })}
            </div>

            {error && <p className={shell.notice}>{error}</p>}

            {canWrite && (
                <div className={shell.sectionActions}>
                    <Button variant='secondary' icon='plus' onClick={() => setDialog({ destination: null })}>
                        Ajouter une destination
                    </Button>
                </div>
            )}

            <DestinationDialog
                open={dialog !== null}
                destination={dialog?.destination ?? null}
                onClose={() => setDialog(null)}
                onSaved={changed}
            />

            <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
        </div>
    );
}

export default DestinationsSection;
