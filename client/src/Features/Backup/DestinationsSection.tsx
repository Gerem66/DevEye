import { useCallback, useEffect, useState } from 'react';
import type { BackupDestination, BackupDestinationProbe } from 'deveye-types';

import Button from '@/Components/Button';
import { Dialog } from '@/Components/Dialog';
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
    const [confirm, setConfirm] = useState<BackupDestination | null>(null);
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

    const remove = async (destination: BackupDestination) => {
        setError(null);
        try {
            await ws.send('backup.destinationRemove', { destinationId: destination.id });
            setConfirm(null);
            changed();
        } catch (e) {
            setError(backupError(e, 'Impossible de retirer cette destination.'));
        }
    };

    return (
        <>
            <div className={styles.list}>
                {destinations === null && <p className={styles.empty}>Chargement…</p>}
                {destinations?.length === 0 && (
                    <p className={styles.empty}>
                        {canWrite
                            ? 'Aucune destination. Déclarez-en une pour pouvoir programmer une sauvegarde.'
                            : 'Aucune destination. Un membre disposant du droit d’écriture peut en déclarer une.'}
                    </p>
                )}
                {(destinations ?? []).map((destination) => (
                    <div key={destination.id} className={styles.row}>
                        <span
                            className={`icon icon-${DESTINATION_ICONS[destination.kind]} ${styles.rowIcon}`}
                            aria-hidden='true'
                        />
                        <div className={styles.rowMain}>
                            <p className={styles.rowName}>
                                <span
                                    className={styles.statusDot}
                                    data-tone={destinationTone(destination.status)}
                                    aria-hidden='true'
                                />
                                {destination.name}
                            </p>
                            <p className={styles.rowMeta}>
                                {DESTINATION_LABELS[destination.kind]}
                                {destination.kind === 'device' && destination.deviceName
                                    ? ` · ${destination.deviceName}`
                                    : ''}
                                {destination.kind === 's3' && destination.bucket ? ` · ${destination.bucket}` : ''}
                                {destination.path ? ` · ${destination.path}` : ''}
                                {destination.encrypt ? ' · chiffrée' : ''}
                            </p>
                            <p className={styles.rowMeta}>
                                {destination.status === 'unknown'
                                    ? 'Jamais contrôlée'
                                    : `Contrôlée ${formatAgo(destination.checkedAt)}`}
                                {destination.jobCount > 0
                                    ? ` · ${destination.jobCount} travail${destination.jobCount > 1 ? 'x' : ''}`
                                    : ''}
                            </p>
                            {probes[destination.id]?.ok && (
                                <p className={styles.rowMeta}>
                                    {probes[destination.id].usedBytes !== null
                                        ? `${formatBytes(probes[destination.id].usedBytes ?? 0)} occupés`
                                        : 'Occupation inconnue'}
                                    {probes[destination.id].freeBytes !== null
                                        ? ` · ${formatBytes(probes[destination.id].freeBytes ?? 0)} libres`
                                        : ''}
                                </p>
                            )}
                            {destination.lastError && <p className={styles.rowError}>{destination.lastError}</p>}
                        </div>
                        <div className={styles.rowActions}>
                            {canWrite && (
                                <>
                                    <Button
                                        variant='ghost'
                                        icon={testing === destination.id ? 'spinner' : 'refresh'}
                                        disabled={testing !== null}
                                        onClick={() => void test(destination)}
                                    >
                                        {testing === destination.id ? 'Contrôle…' : 'Tester'}
                                    </Button>
                                    <Button variant='ghost' icon='edit' onClick={() => setDialog({ destination })}>
                                        Modifier
                                    </Button>
                                    <Button variant='ghost' icon='trash' onClick={() => setConfirm(destination)}>
                                        Retirer
                                    </Button>
                                </>
                            )}
                        </div>
                    </div>
                ))}
                {error && <p className={styles.error}>{error}</p>}
                {canWrite && (
                    <div>
                        <Button variant='ghost' icon='plus' onClick={() => setDialog({ destination: null })}>
                            Nouvelle destination
                        </Button>
                    </div>
                )}
            </div>

            <DestinationDialog
                open={dialog !== null}
                destination={dialog?.destination ?? null}
                onClose={() => setDialog(null)}
                onSaved={changed}
            />

            <Dialog
                open={confirm !== null}
                onClose={() => setConfirm(null)}
                onSubmit={() => confirm && void remove(confirm)}
                title='Retirer cette destination ?'
                description={
                    confirm?.jobCount
                        ? `${confirm.jobCount} travail(aux) écrivent encore ici. Changez leur destination d’abord.`
                        : 'Les archives déjà écrites ne sont pas touchées : DevEye ne détruit rien chez vous en rangeant sa configuration.'
                }
                width={480}
                footer={
                    <>
                        <Button variant='ghost' onClick={() => setConfirm(null)}>
                            Annuler
                        </Button>
                        <Button
                            variant='danger'
                            disabled={(confirm?.jobCount ?? 0) > 0}
                            onClick={() => confirm && void remove(confirm)}
                        >
                            Retirer
                        </Button>
                    </>
                }
            />
        </>
    );
}

export default DestinationsSection;
