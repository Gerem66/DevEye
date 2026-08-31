import type { Device } from '@deveye/types';

import type { DeviceAction } from '../DeviceActionsMenu';
import type { DeviceActions } from './useDeviceActions';

/**
 * Les gestes qui portent sur l'appareil lui-même, dans l'ordre de son cycle de
 * vie : approuver, renommer, révoquer ou réactiver, interrompre son agent,
 * supprimer. Rendus dans le menu d'actions de sa fiche, sous le droit
 * `devices: write` de l'espace ; un appareil qu'on ne fait que voir depuis une
 * projection se gère chez lui.
 */
export function deviceLifecycleActions(device: Device, actions: DeviceActions, canWrite: boolean): DeviceAction[] {
    if (!canWrite || device.foreign || device.status === 'archived') return [];
    const target = { id: device.id, name: device.name };

    if (device.status === 'pending_deletion') {
        return [
            {
                icon: 'icon-x-circle',
                label: 'Annuler la suppression',
                onClick: () => void actions.cancelDeleteDevice(device.id)
            },
            { icon: 'icon-trash', label: 'Supprimer sans attendre', onClick: () => actions.setForceTarget(target) }
        ];
    }

    return [
        ...(device.status === 'pending'
            ? [
                  {
                      icon: 'icon-check-circle',
                      label: 'Approuver l’appareil',
                      onClick: () => void actions.confirmDevice(device.id)
                  }
              ]
            : []),
        { icon: 'icon-edit', label: 'Renommer l’appareil', onClick: () => actions.openRename(device.id, device.name) },
        ...(device.status === 'revoked'
            ? [
                  {
                      icon: 'icon-check-circle',
                      label: 'Réactiver l’appareil',
                      onClick: () => void actions.reactivateDevice(device.id)
                  }
              ]
            : [
                  {
                      icon: 'icon-x-circle',
                      label: 'Révoquer l’appareil',
                      onClick: () => void actions.revokeDevice(device.id)
                  }
              ]),
        ...(device.online
            ? [{ icon: 'icon-power', label: 'Interrompre l’agent', onClick: () => actions.setStopTarget(target) }]
            : []),
        { icon: 'icon-trash', label: 'Supprimer l’appareil', onClick: () => actions.setDeleteTarget(target) }
    ];
}
