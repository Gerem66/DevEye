import { Button, ConfirmDialog, Dialog, TextInput } from 'deveye-sdk-client';
import type { Device } from '@deveye/types';

import type { DeviceActions } from './useDeviceActions';
import styles from './style.module.css';

/**
 * Les dialogues de confirmation des gestes qui engagent : renommer, supprimer,
 * et le dialogue commun qui confirme l'approbation, la révocation et
 * l'effacement. Montés par la fiche d'un appareil, à côté de son menu
 * d'actions et de sa popup « Agent » qui les ouvrent.
 */
export function DeviceDialogs({ actions, device }: { actions: DeviceActions; device: Device }) {
    return (
        <>
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
                    fiche de l’appareil.
                </p>
                {device.report?.agent?.policy.destroy === false && (
                    <p className={styles.deleteExplainNote}>
                        Cet agent refuse de s’effacer à distance (politique locale, <code>allow_destroy</code>) : la
                        suppression s’interrompra. Désinstallez-le sur la machine, ou supprimez sans attendre.
                    </p>
                )}
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
                    Ses relevés restent consultables.
                </p>
            </Dialog>

            <ConfirmDialog request={actions.confirmRequest} onClose={actions.closeConfirm} />
        </>
    );
}
