import { useEffect, useState } from 'react';
import type { UptimeClientProvider, UptimeLinkedService } from '@deveye/types/sdk/client';
import type { UptimeService } from '../contracts/domain';

import { api } from './api';
import Ratios from './Ratios';
import { ServiceDialog } from './ServiceDialog';
import StatusBars from './StatusBars';
import { useServiceHistory } from './useServiceHistory';

/**
 * Ce que le module offre aux écrans de l'app (`UPTIME_CLIENT_PROVIDER`) :
 * l'onglet Déploiement d'un projet compose bande d'état, taux et dialogue sans
 * importer le module.
 */

interface LinkedServiceDialogProps {
    open: boolean;
    service: UptimeLinkedService | null;
    onClose: () => void;
    onSaved: (service: UptimeLinkedService) => void;
}

/**
 * Le contrat tend un `UptimeLinkedService` ; le dialogue réécrit le service
 * entier et a besoin de sa fiche complète. L'adaptateur la recharge par
 * `uptime.list` et n'ouvre le dialogue qu'avec elle ; `service: null` (une
 * déclaration) n'a rien à charger.
 */
function LinkedServiceDialog({ open, service, onClose, onSaved }: LinkedServiceDialogProps) {
    const [full, setFull] = useState<UptimeService | null>(null);

    useEffect(() => {
        if (!open || service === null) {
            setFull(null);
            return;
        }
        let alive = true;
        api.send('uptime.list', {})
            .then((res) => {
                if (alive) setFull(res.services.find((s) => s.id === service.id) ?? null);
            })
            .catch(() => {
                if (alive) setFull(null);
            });
        return () => {
            alive = false;
        };
    }, [open, service]);

    // Un service réduit pas encore rechargé : le dialogue attend, fermé,
    // plutôt que de s'ouvrir sur des réglages par défaut qu'il réécrirait.
    return (
        <ServiceDialog
            open={open && (service === null || full !== null)}
            service={service === null ? null : full}
            onClose={onClose}
            onSaved={onSaved}
        />
    );
}

export const clientProvider: UptimeClientProvider = {
    listServices: async () => (await api.send('uptime.list', {})).services,
    useServiceHistory,
    StatusBars,
    Ratios,
    ServiceDialog: LinkedServiceDialog
};
