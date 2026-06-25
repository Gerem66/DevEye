import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Dialog } from '@/Components/Dialog';
import Button from '@/Components/Button';
import TextInput from '@/Components/TextInput';
import { useDevices } from '@/stores/devices';
import { DownloadAgent } from './DownloadAgent';
import { PackagesPanel } from './PackagesPanel';
import { DeviceCard } from './DeviceCard';
import { LinkCodesDialog } from './LinkCodesDialog';
import { useLinkCodes } from './useLinkCodes';
import { useDeviceActions } from './useDeviceActions';
import type { FeatureProps } from '../types';
import styles from './Clients.module.css';

/**
 * Appareils page: fleet management (admin). Orchestrates the device grid
 * ({@link DeviceCard}), link-code generation ({@link useLinkCodes}) and the
 * device actions ({@link useDeviceActions}); the heavy logic lives in those
 * modules so this stays a thin shell.
 */
export default function Clients({ user: _user, workspace: _ws }: FeatureProps) {
    const { devices, loading, error, refresh } = useDevices();
    const [showDownloadModal, setShowDownloadModal] = useState(false);
    const links = useLinkCodes(refresh);
    const actions = useDeviceActions(refresh);

    // Archived devices are gone from management; they live (read-only) in
    // Monitoring for browsing their frozen history.
    const visibleDevices = devices.filter((d) => d.status !== 'archived');

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <div className={styles.headerText}>
                    <h2 className={styles.title}>Appareils</h2>
                    <p className={styles.subtitle}>Gérez vos agents DevEye</p>
                </div>
                <button className={styles.addBtn} onClick={links.openLinkModal} disabled={links.generatingCode}>
                    {links.generatingCode ? (
                        <span className={styles.spinner} />
                    ) : (
                        <>
                            <span className='icon icon-plus' />
                            Ajouter un appareil
                        </>
                    )}
                </button>
            </div>

            {actions.actionError && <div className={styles.errorBanner}>{actions.actionError}</div>}

            {loading && devices.length === 0 ? (
                <div className={styles.loader}>Chargement…</div>
            ) : error && devices.length === 0 ? (
                <div className={styles.empty}>
                    <span className={styles.emptyIcon}>⚠️</span>
                    <p>{error}</p>
                </div>
            ) : visibleDevices.length === 0 ? (
                <div className={styles.empty}>
                    <span className={styles.emptyIcon}>🖥️</span>
                    <p>Aucun appareil lié</p>
                    <p className={styles.hint}>
                        Cliquez sur &quot;Ajouter un appareil&quot; pour générer un code de liaison.
                    </p>
                </div>
            ) : (
                <div className={styles.deviceGrid}>
                    {/* No entrance/layout animation here: the cards are plain children of
                        the popup so they morph in and out *with* it (the shared-element
                        transition). Only deletions animate, via exit. */}
                    <AnimatePresence initial={false}>
                        {visibleDevices.map((device) => (
                            <motion.div
                                key={device.id}
                                className={styles.deviceCard}
                                exit={{ opacity: 0, scale: 0.96 }}
                                transition={{ duration: 0.2, ease: 'easeOut' }}
                            >
                                <DeviceCard device={device} actions={actions} />
                            </motion.div>
                        ))}
                    </AnimatePresence>
                </div>
            )}

            <LinkCodesDialog links={links} onDownload={() => setShowDownloadModal(true)} />

            <Dialog
                open={actions.deleteTarget !== null}
                onClose={() => actions.setDeleteTarget(null)}
                title={actions.deleteTarget ? `Supprimer « ${actions.deleteTarget.name} » ?` : 'Supprimer'}
                description='La suppression de l’appareil entraînera la destruction définitive de l’agent.'
                onSubmit={() => void actions.confirmRemoveDevice()}
                footer={
                    <>
                        <Button
                            variant='secondary'
                            onClick={() => actions.setDeleteTarget(null)}
                            disabled={actions.deleting}
                        >
                            Annuler
                        </Button>
                        <Button variant='danger' onClick={actions.confirmRemoveDevice} disabled={actions.deleting}>
                            {actions.deleting ? 'Suppression…' : 'Supprimer l’appareil'}
                        </Button>
                    </>
                }
            >
                <p className={styles.deleteExplainNote}>
                    En cas d’échec de l’auto-destruction, la suppression est interrompue et l’erreur s’affiche sur la
                    carte de l’appareil.
                </p>
            </Dialog>

            <Dialog
                open={actions.renameTarget !== null}
                onClose={() => actions.setRenameTarget(null)}
                title='Renommer l’appareil'
                description={
                    actions.renameTarget
                        ? `Choisissez un nouveau nom pour « ${actions.renameTarget.name} ».`
                        : 'Renommer'
                }
                width={420}
                onSubmit={() => void actions.confirmRename()}
                footer={
                    <>
                        <Button
                            variant='secondary'
                            onClick={() => actions.setRenameTarget(null)}
                            disabled={actions.renaming}
                        >
                            Annuler
                        </Button>
                        <Button
                            onClick={actions.confirmRename}
                            disabled={
                                actions.renaming ||
                                actions.renameValue.trim() === '' ||
                                actions.renameValue.trim() === actions.renameTarget?.name
                            }
                        >
                            {actions.renaming ? 'Renommage…' : 'Renommer'}
                        </Button>
                    </>
                }
            >
                <TextInput
                    value={actions.renameValue}
                    maxLength={128}
                    placeholder='Nom de l’appareil'
                    aria-label='Nouveau nom de l’appareil'
                    onChange={(e) => actions.setRenameValue(e.target.value)}
                />
            </Dialog>

            <Dialog
                open={actions.forceTarget !== null}
                onClose={() => actions.setForceTarget(null)}
                title={actions.forceTarget ? `Supprimer « ${actions.forceTarget.name} » sans attendre ?` : 'Supprimer'}
                description='L’appareil sera archivé immédiatement, sans attendre la reconnexion de l’agent.'
                onSubmit={() => void actions.confirmForceDelete()}
                footer={
                    <>
                        <Button
                            variant='secondary'
                            onClick={() => actions.setForceTarget(null)}
                            disabled={actions.forcing}
                        >
                            Annuler
                        </Button>
                        <Button variant='danger' onClick={actions.confirmForceDelete} disabled={actions.forcing}>
                            {actions.forcing ? 'Suppression…' : 'Supprimer sans attendre'}
                        </Button>
                    </>
                }
            >
                <p className={styles.deleteExplainNote}>
                    L’agent ne sera pas auto-détruit. À utiliser s’il n’existe plus, ou si peu importe qu’il se nettoie.
                    Ses données restent consultables dans Monitoring.
                </p>
            </Dialog>

            <Dialog
                open={actions.packagesTarget !== null}
                onClose={() => actions.setPackagesTarget(null)}
                title={actions.packagesTarget ? `Mises à jour — « ${actions.packagesTarget.name} »` : 'Mises à jour'}
                description='Gestionnaires détectés sur l’appareil et application des mises à jour en direct.'
                footer={
                    <Button variant='secondary' onClick={() => actions.setPackagesTarget(null)}>
                        Fermer
                    </Button>
                }
            >
                {actions.packagesTarget && <PackagesPanel deviceId={actions.packagesTarget.id} />}
            </Dialog>

            <DownloadAgent open={showDownloadModal} onClose={() => setShowDownloadModal(false)} />
        </div>
    );
}
