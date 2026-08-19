import { useState } from 'react';
import type { BackupDestination } from 'deveye-types';

import type { BackupDestinationProbe } from 'deveye-types';

import { Button, Dialog } from '@/Components';
import { ws } from '@/api/ws';
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

interface DestinationsPanelProps {
    open: boolean;
    destinations: BackupDestination[];
    canWrite: boolean;
    onClose: () => void;
    onCreate: () => void;
    onEdit: (destination: BackupDestination) => void;
    onChanged: () => void;
}

/**
 * La liste des destinations de l'espace, dans son propre dialogue.
 *
 * Séparée de l'écran principal parce qu'on ne la touche presque jamais : on
 * déclare son Raspberry une fois, puis on n'y revient que le jour où un contrôle
 * passe au rouge. La vue de tête doit montrer ce qui bouge — les travaux — pas
 * ce qui ne bouge pas.
 */
export function DestinationsPanel({
    open,
    destinations,
    canWrite,
    onClose,
    onCreate,
    onEdit,
    onChanged
}: DestinationsPanelProps) {
    const [testing, setTesting] = useState<number | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [confirm, setConfirm] = useState<BackupDestination | null>(null);
    /**
     * Ce que le dernier contrôle a mesuré, par destination.
     *
     * En mémoire de l'écran seulement, pas en base : l'occupation d'un bucket
     * change à chaque sauvegarde, et la ranger en base voudrait dire l'y écrire
     * à chaque passage — donc afficher, le reste du temps, un chiffre faux avec
     * l'autorité d'une donnée enregistrée. Elle n'a de sens qu'au moment où on
     * vient de la mesurer.
     */
    const [probes, setProbes] = useState<Record<number, BackupDestinationProbe>>({});

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
            onChanged();
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
            onChanged();
        } catch (e) {
            setError(backupError(e, 'Impossible de retirer cette destination.'));
        }
    };

    return (
        <>
            <Dialog
                open={open}
                onClose={onClose}
                title='Destinations'
                description='Les endroits qui reçoivent vos archives. Un même endroit peut servir plusieurs travaux.'
                width={680}
                footer={
                    <>
                        <Button variant='ghost' onClick={onClose}>
                            Fermer
                        </Button>
                        {canWrite && (
                            <Button icon='plus' onClick={onCreate}>
                                Nouvelle destination
                            </Button>
                        )}
                    </>
                }
            >
                <div className={styles.list}>
                    {destinations.length === 0 && (
                        <p className={styles.empty}>
                            Aucune destination. Déclarez-en une pour pouvoir programmer une sauvegarde.
                        </p>
                    )}
                    {destinations.map((destination) => (
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
                                        <Button variant='ghost' icon='edit' onClick={() => onEdit(destination)}>
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
                </div>
            </Dialog>

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

export default DestinationsPanel;
