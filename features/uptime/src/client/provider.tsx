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
 * l'onglet Déploiement d'un projet compose la bande d'état, les taux et le
 * dialogue de déclaration d'un service, sans importer le module.
 *
 * Les composants du module sont des sur-ensembles compatibles du contrat : la
 * bande et les taux lisent des champs que `UptimeLinkedService` porte, le
 * hook d'historique rend des points de la forme attendue. Seul le dialogue
 * demande plus (la méthode, le mot-clé, les réglages qu'il conserve), d'où
 * l'adaptateur ci-dessous.
 */

interface LinkedServiceDialogProps {
    open: boolean;
    service: UptimeLinkedService | null;
    onClose: () => void;
    onSaved: (service: UptimeLinkedService) => void;
}

/**
 * Le dialogue de la feature, ouvert par l'hôte sur un service réduit.
 *
 * Le contrat tend un `UptimeLinkedService` ; le dialogue, lui, réécrit le
 * service entier et a donc besoin de sa fiche complète (méthode, mot-clé, et
 * les quatre réglages qu'il ne montre plus mais conserve). Plutôt qu'un
 * formulaire réduit qui divergerait au premier réglage ajouté, l'adaptateur
 * recharge la fiche par `uptime.list` et n'ouvre le vrai dialogue qu'avec
 * elle. `service: null` (une déclaration, le seul cas de Projets aujourd'hui)
 * n'a rien à charger.
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
