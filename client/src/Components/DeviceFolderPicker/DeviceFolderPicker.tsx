import { useCallback, useEffect, useRef, useState } from 'react';
import {
    DEVICE_FILES_LISTING_EVENT,
    DEVICE_FILES_OP_EVENT,
    type DeviceFilesListingPush,
    type DeviceFilesOpPush,
    type FileListing
} from '@deveye/types';

import { ws } from '@/api/ws';
import { joinPath } from '@/devicePath';
import { acquireMetrics } from '@/stores/metricsSubscription';
import Button from '../Button';
import { Dialog } from '../Dialog';
import TextInput from '../TextInput';
import styles from './DeviceFolderPicker.module.css';

interface DeviceFolderPickerProps {
    open: boolean;
    deviceId: string;
    deviceName: string;
    onClose: () => void;
    /** Appelé avec le chemin absolu du dossier choisi sur l'appareil. */
    onPick: (path: string) => void;
    /** À quoi le dossier va servir, dit par l'appelant : le composant sert la
     *  synchronisation d'un partage comme la destination d'une sauvegarde. */
    description?: string;
}

/**
 * Mini-explorateur de dossiers d'un appareil, sur les commandes de l'explorateur
 * de fichiers (`agent.filesList` + push corrélé par opId). Partagé : choisir un
 * dossier sur une machine distante n'appartient ni à CloudSync ni aux
 * Sauvegardes.
 */
export function DeviceFolderPicker({
    open,
    deviceId,
    deviceName,
    onClose,
    onPick,
    description
}: DeviceFolderPickerProps) {
    const [listing, setListing] = useState<FileListing | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [mkdirOpen, setMkdirOpen] = useState(false);
    const [mkdirName, setMkdirName] = useState('');
    const listOp = useRef('');
    const mutateOp = useRef('');
    /** Chemin du dossier qu'un mkdir en cours vient de créer, ouvert au succès. */
    const mkdirTarget = useRef<string | null>(null);
    /**
     * Le dossier affiché, en référence : les gestionnaires de push vivent dans
     * un abonnement monté une fois, lire l'état `listing` y capturerait `null`,
     * et l'ajouter aux dépendances réabonnerait à chaque navigation.
     */
    const pathRef = useRef('/');

    const navigate = useCallback(
        (target: string) => {
            const opId = crypto.randomUUID();
            listOp.current = opId;
            setLoading(true);
            setError(null);
            void ws.send('agent.filesList', { deviceId, opId, path: target }).catch((e) => {
                setLoading(false);
                setError(e instanceof Error ? e.message : 'Échec');
            });
        },
        [deviceId]
    );

    // Les réponses de l'agent (`files.listing`) ne sont diffusées qu'aux
    // abonnés de l'appareil (`hub.publishToSubscribers`) : sans abonnement, le
    // serveur jette la réponse. Le compte de références n'interrompt pas
    // l'abonnement d'un autre écran ouvert sur la même machine.
    useEffect(() => {
        if (!open) return;
        return acquireMetrics(deviceId);
    }, [open, deviceId]);

    useEffect(() => {
        if (!open) return;
        const off = ws.onMessage((msg) => {
            if (msg.command === DEVICE_FILES_LISTING_EVENT && msg.payload.ok) {
                const d = msg.payload.data as DeviceFilesListingPush;
                if (d.deviceId !== deviceId || d.opId !== listOp.current) return;
                setLoading(false);
                if (d.error || !d.listing) {
                    setError(d.error ?? 'Dossier illisible');
                    return;
                }
                setError(null);
                setListing(d.listing);
                pathRef.current = d.listing.path;
                return;
            }
            if (msg.command === DEVICE_FILES_OP_EVENT && msg.payload.ok) {
                const d = msg.payload.data as DeviceFilesOpPush;
                if (d.deviceId !== deviceId || d.opId !== mutateOp.current) return;
                const created = mkdirTarget.current;
                mkdirTarget.current = null;
                // Un dossier créé s'ouvre directement ; le dossier courant a
                // changé de toute façon.
                if (d.ok) navigate(created ?? pathRef.current);
                else setError(d.error ?? 'Création impossible');
            }
        });
        // Navigation lancée après l'écoute, sinon une réponse rapide se perdrait.
        // On repart de la racine : rouvrir sur une autre machine ne doit pas
        // montrer les dossiers de la précédente.
        setListing(null);
        pathRef.current = '/';
        navigate('/');
        return off;
    }, [open, deviceId, navigate]);

    /** Re-liste le dossier courant (le contenu distant a pu bouger sous nous). */
    const refresh = () => navigate(listing?.path ?? '/');

    const createFolder = () => {
        const name = mkdirName.trim();
        if (name === '' || !listing) return;
        const opId = crypto.randomUUID();
        mutateOp.current = opId;
        mkdirTarget.current = joinPath(listing.path, name);
        setMkdirOpen(false);
        setError(null);
        void ws.send('agent.filesMutate', { deviceId, opId, op: 'mkdir', path: mkdirTarget.current }).catch((e) => {
            mkdirTarget.current = null;
            setError(e instanceof Error ? e.message : 'Création impossible');
        });
    };

    const dirs = (listing?.entries ?? []).filter((e) => e.kind === 'dir');

    return (
        <>
            <Dialog
                open={open}
                onClose={onClose}
                title={`Dossier sur « ${deviceName} »`}
                description={description}
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
                <div className={styles.pickerBar}>
                    <span className={styles.pickerPath}>{loading ? 'Chargement…' : (listing?.path ?? '—')}</span>
                    <button
                        type='button'
                        className={styles.pickerIconBtn}
                        title='Actualiser'
                        aria-label='Actualiser'
                        onClick={refresh}
                    >
                        <span className='icon icon-refresh' />
                    </button>
                    <button
                        type='button'
                        className={styles.pickerIconBtn}
                        title='Nouveau dossier'
                        aria-label='Nouveau dossier'
                        disabled={!listing}
                        onClick={() => {
                            setMkdirName('');
                            setMkdirOpen(true);
                        }}
                    >
                        <span className='icon icon-folder-plus' />
                    </button>
                </div>
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
                            onClick={() => navigate(joinPath(listing?.path ?? '/', entry.name))}
                        >
                            <span className='icon icon-folder' />
                            {entry.name}
                        </button>
                    ))}
                    {!loading && dirs.length === 0 && <div className={styles.mutedNote}>Aucun sous-dossier.</div>}
                </div>
            </Dialog>

            {/* Empilé au-dessus du sélecteur : il possède alors la couche de
                fermeture, donc Échap annule la saisie du nom sans refermer le
                sélecteur derrière. */}
            <Dialog
                open={mkdirOpen}
                onClose={() => setMkdirOpen(false)}
                title='Nouveau dossier'
                description={listing ? `Il sera créé dans ${listing.path}.` : undefined}
                width={420}
                onSubmit={createFolder}
                footer={
                    <>
                        <Button variant='secondary' onClick={() => setMkdirOpen(false)}>
                            Annuler
                        </Button>
                        <Button disabled={mkdirName.trim() === ''} onClick={createFolder}>
                            Créer
                        </Button>
                    </>
                }
            >
                <TextInput value={mkdirName} onChange={(e) => setMkdirName(e.target.value)} placeholder='Nom' />
            </Dialog>
        </>
    );
}

export default DeviceFolderPicker;
