import type { FleetDevice } from '../../contracts/commands';
import { ARCHIVED, FOREIGN, firstReason, NO_WRITE } from '../availability';
import type { DeviceAction } from '../DeviceActionsMenu';
import type { DeviceActions } from './useDeviceActions';

/**
 * Les gestes qui portent sur la fiche de l'appareil, en fin du menu
 * « Fonctions » : le renommer, le supprimer. Ceux qui portent sur son agent
 * (approuver, révoquer, interrompre) sont dans la popup « Agent ». Aucun n'est
 * masqué : ce qui les empêche se lit sur eux (droit d'écriture, appareil venu
 * d'un autre espace, archivé).
 *
 * Un appareil archivé refuse tout SAUF l'effacement de sa fiche et de son
 * historique (`devices.delete`), le seul moyen de s'en défaire : son agent
 * n'existe plus, rien ne lui demande de s'effacer.
 */
export function deviceLifecycleActions(device: FleetDevice, actions: DeviceActions, canWrite: boolean): DeviceAction[] {
    const target = { id: device.id, name: device.name };
    // Ce qui vaut pour tous : le droit, puis le domicile de l'appareil.
    const fleet = firstReason(!canWrite && NO_WRITE, device.foreign && FOREIGN);
    // Ce qui vaut pour tous sauf l'effacement : l'agent doit encore exister.
    const managed = firstReason(fleet, device.status === 'archived' && ARCHIVED);

    if (device.status === 'pending_deletion') {
        return [
            {
                icon: 'icon-x-circle',
                label: 'Annuler la suppression',
                onClick: () => void actions.cancelDeleteDevice(device.id),
                unavailable: managed
            },
            {
                icon: 'icon-trash',
                label: 'Supprimer sans attendre',
                onClick: () => actions.setForceTarget(target),
                unavailable: managed
            }
        ];
    }

    return [
        {
            icon: 'icon-edit',
            label: 'Renommer l’appareil',
            onClick: () => actions.openRename(device.id, device.name),
            unavailable: managed
        },
        device.status === 'archived'
            ? {
                  icon: 'icon-trash',
                  label: 'Effacer l’appareil et son historique',
                  onClick: () => actions.askPurge(target),
                  unavailable: fleet
              }
            : {
                  icon: 'icon-trash',
                  label: 'Supprimer l’appareil',
                  onClick: () => actions.setDeleteTarget(target),
                  unavailable: fleet
              }
    ];
}
