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
    /**
     * À quoi le dossier va servir, dit par l'appelant.
     *
     * Le composant ne le sait pas : il sert la synchronisation d'un partage
     * comme la destination d'une sauvegarde, et une phrase codée en dur pour
     * l'un des deux mentirait à l'autre.
     */
    description?: string;
}

/**
 * Mini-explorateur de dossiers d'un appareil, sur les commandes de
 * l'explorateur de fichiers du Monitoring (`device.filesList` + push corrélé
 * par opId) — dossiers uniquement, avec « Choisir ce dossier », « Actualiser »
 * et « Nouveau dossier ».
 *
 * Partagé plutôt que rangé dans une feature : choisir un dossier sur une machine
 * distante n'appartient ni à CloudSync ni aux Sauvegardes, et la troisième
 * recopie aurait été celle de trop.
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
     * Le dossier affiché, en référence. Les gestionnaires de push vivent dans un
     * abonnement monté UNE fois : y lire l'état `listing` capturerait sa valeur
     * du premier rendu (donc `null`) pour toute la vie du dialogue. Le remettre
     * dans les dépendances de l'effet serait pire — chaque navigation
     * réabonnerait et relancerait une navigation vers la racine.
     */
    const pathRef = useRef('/');

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
                // Un dossier créé s'ouvre directement : c'est presque toujours
                // celui qu'on venait chercher, et ça vaut re-listage de toute
                // façon puisque le contenu du dossier courant a changé.
                if (d.ok) navigate(created ?? pathRef.current);
                else setError(d.error ?? 'Création impossible');
            }
        });
        // Navigation lancée APRÈS l'écoute, sinon une réponse rapide arriverait
        // avant l'abonnement local et se perdrait à son tour. On repart de la
        // racine et on vide l'ancienne arborescence : rouvrir le dialogue sur
        // une autre machine ne doit pas montrer les dossiers de la précédente.
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
        void ws.send('device.filesMutate', { deviceId, opId, op: 'mkdir', path: mkdirTarget.current }).catch((e) => {
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
