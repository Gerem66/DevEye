import type { FleetDevice } from '../../contracts/commands';
import { ARCHIVED, FOREIGN, firstReason, NO_WRITE, OFFLINE, PLAN_PAUSED } from '../availability';
import type { DeviceAction } from '../DeviceActionsMenu';
import type { DeviceActions } from './useDeviceActions';

/**
 * Les gestes qui portent sur l'appareil lui-même, dans l'ordre de son cycle de
 * vie : approuver, renommer, révoquer ou réactiver, interrompre son agent,
 * supprimer. Aucun n'est masqué : ce qui les empêche se lit sur eux (droit
 * d'écriture, appareil venu d'un autre espace, archivé, hors ligne).
 *
 * Le motif suit ce que le serveur ferait vraiment, geste par geste : un appareil
 * archivé refuse tout SAUF la purge de son historique (`devices.delete`
 * l'accepte, c'est même le seul moyen de s'en défaire), et seule l'interruption
 * de l'agent exige qu'il soit en ligne.
 */
export function deviceLifecycleActions(device: FleetDevice, actions: DeviceActions, canWrite: boolean): DeviceAction[] {
    const target = { id: device.id, name: device.name };
    // Ce qui vaut pour tous : le droit, puis le domicile de l'appareil.
    const fleet = firstReason(!canWrite && NO_WRITE, device.foreign && FOREIGN);
    // Ce qui vaut pour tous sauf la purge : l'agent doit encore exister.
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
        ...(device.status === 'pending'
            ? [
                  {
                      icon: 'icon-check-circle',
                      label: 'Approuver l’appareil',
                      onClick: () => void actions.confirmDevice(device.id),
                      unavailable: managed
                  }
              ]
            : []),
        {
            icon: 'icon-edit',
            label: 'Renommer l’appareil',
            onClick: () => actions.openRename(device.id, device.name),
            unavailable: managed
        },
        ...(device.status === 'revoked'
            ? [
                  {
                      icon: 'icon-check-circle',
                      label: 'Réactiver l’appareil',
                      onClick: () => void actions.reactivateDevice(device.id),
                      unavailable: managed
                  }
              ]
            : [
                  {
                      icon: 'icon-x-circle',
                      label: 'Révoquer l’appareil',
                      onClick: () => void actions.revokeDevice(device.id),
                      unavailable: managed
                  }
              ]),
        {
            icon: 'icon-power',
            label: 'Interrompre l’agent',
            onClick: () => actions.setStopTarget(target),
            unavailable: firstReason(managed, device.planPaused && PLAN_PAUSED, !device.online && OFFLINE)
        },
        {
            icon: 'icon-trash',
            label: 'Supprimer l’appareil',
            onClick: () => actions.setDeleteTarget(target),
            unavailable: fleet
        }
    ];
}
