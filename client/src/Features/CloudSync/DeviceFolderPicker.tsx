import { useCallback, useEffect, useRef, useState } from 'react';
import { DEVICE_FILES_LISTING_EVENT, type DeviceFilesListingPush, type FileListing } from 'deveye-types';

import { ws } from '@/api/ws';
import { Button, Dialog } from '@/Components';
import { acquireMetrics } from '@/stores/metricsSubscription';
import styles from './style.module.css';

interface DeviceFolderPickerProps {
    open: boolean;
    deviceId: string;
    deviceName: string;
    onClose: () => void;
    /** Appelé avec le chemin absolu du dossier choisi sur l'appareil. */
    onPick: (path: string) => void;
}

/**
 * Mini-explorateur de dossiers d'un appareil, sur les commandes de
 * l'explorateur de fichiers du Monitoring (`device.filesList` + push corrélé
 * par opId) — dossiers uniquement, avec « Choisir ce dossier ».
 */
export default function DeviceFolderPicker({ open, deviceId, deviceName, onClose, onPick }: DeviceFolderPickerProps) {
    const [listing, setListing] = useState<FileListing | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const listOp = useRef('');

    const navigate = useCallback(
        (target: string) => {
            const opId = crypto.randomUUID();
            listOp.current = opId;
            setLoading(true);
            setError(null);
            void ws.send('device.filesList', { deviceId, opId, path: target }).catch((e) => {
                setLoading(false);
                setError(e instanceof Error ? e.message : 'Échec');
            });
        },
        [deviceId]
    );

    // Les réponses de l'agent (`files.listing`) ne sont diffusées qu'aux
    // ABONNÉS de l'appareil (`hub.publishToSubscribers`). Sans abonnement, la
    // commande partait bien, l'agent répondait bien, et le serveur jetait sa
    // réponse faute de destinataire : « Chargement… » à l'infini. Chaque
    // panneau du Monitoring qui consomme un push d'appareil prend le même
    // abonnement ; celui-ci manquait ici. Le compte de références empêche de
    // couper l'abonnement d'un autre écran ouvert sur la même machine.
    useEffect(() => {
        if (!open) return;
        return acquireMetrics(deviceId);
    }, [open, deviceId]);

    useEffect(() => {
        if (!open) return;
        const off = ws.onMessage((msg) => {
            if (msg.command !== DEVICE_FILES_LISTING_EVENT || !msg.payload.ok) return;
            const d = msg.payload.data as DeviceFilesListingPush;
            if (d.deviceId !== deviceId || d.opId !== listOp.current) return;
            setLoading(false);
            if (d.error || !d.listing) {
                setError(d.error ?? 'Dossier illisible');
                return;
            }
            setError(null);
            setListing(d.listing);
        });
        // Navigation lancée APRÈS l'écoute, sinon une réponse rapide arriverait
        // avant l'abonnement local et se perdrait à son tour. On repart de la
        // racine et on vide l'ancienne arborescence : rouvrir le dialogue sur
        // une autre machine ne doit pas montrer les dossiers de la précédente.
        setListing(null);
        navigate('/');
        return off;
    }, [open, deviceId, navigate]);

    const dirs = (listing?.entries ?? []).filter((e) => e.kind === 'dir');

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title={`Dossier sur « ${deviceName} »`}
            description='Choisis le dossier local à synchroniser avec le cloud.'
            width={520}
            footer={
                <>
                    <Button variant='secondary' onClick={onClose}>
                        Annuler
                    </Button>
                    <Button disabled={!listing} onClick={() => listing && onPick(listing.path)}>
                        Choisir ce dossier
                    </Button>
                </>
            }
        >
            <div className={styles.pickerPath}>{loading ? 'Chargement…' : (listing?.path ?? '—')}</div>
            {error && <div className={styles.mutedNote}>{error}</div>}
            <div className={styles.pickerList}>
                {listing?.parent && (
                    <button
                        type='button'
                        className={styles.pickerEntry}
                        onClick={() => navigate(listing.parent ?? '/')}
                    >
                        <span className='icon icon-arrow-left' />
                        Dossier parent
                    </button>
                )}
                {dirs.map((entry) => (
                    <button
                        key={entry.name}
                        type='button'
                        className={styles.pickerEntry}
                        onClick={() => {
                            const base = listing?.path ?? '/';
                            const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
                            navigate(base.endsWith(sep) ? `${base}${entry.name}` : `${base}${sep}${entry.name}`);
                        }}
                    >
                        <span className='icon icon-folder' />
                        {entry.name}
                    </button>
                ))}
                {!loading && dirs.length === 0 && <div className={styles.mutedNote}>Aucun sous-dossier.</div>}
            </div>
        </Dialog>
    );
}
