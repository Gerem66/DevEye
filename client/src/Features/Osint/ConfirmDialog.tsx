import { useRef } from 'react';

import { Dialog } from '@/Components/Dialog';
import Button from '@/Components/Button';

/**
 * Confirmation d'une action destructive de l'historique.
 *
 * Même forme que la confirmation de suppression d'appareil
 * (`Features/Clients`) : `Dialog` statique, Entrée câblée sur l'action
 * principale via `onSubmit`, « Annuler » en secondaire et l'action en `danger`.
 *
 * `Dialog` passe par un portail en `z-modal`, donc la boîte se pose au-dessus du
 * tiroir d'historique — et comme les deux s'inscrivent dans la pile
 * `useDismissLayer`, Échap ferme d'abord la confirmation, puis le tiroir.
 */

export interface ConfirmRequest {
    title: string;
    description: string;
    confirmLabel: string;
    onConfirm: () => void;
}

interface Props {
    request: ConfirmRequest | null;
    onClose: () => void;
}

export function ConfirmDialog({ request, onClose }: Props): React.ReactElement {
    /**
     * La dernière demande, gardée le temps de la fermeture.
     *
     * `Dialog` a une animation de sortie : rendre directement `request` ferait
     * clignoter un titre vide pendant les ~200 ms où la boîte s'efface, puisque
     * l'état repasse à `null` avant la fin de l'animation.
     */
    const shown = useRef<ConfirmRequest | null>(request);
    if (request) shown.current = request;
    const view = request ?? shown.current;

    const confirm = (): void => {
        request?.onConfirm();
        onClose();
    };

    return (
        <Dialog
            open={request !== null}
            onClose={onClose}
            title={view?.title ?? ''}
            description={view?.description}
            onSubmit={confirm}
            width={440}
            footer={
                <>
                    <Button variant='secondary' onClick={onClose}>
                        Annuler
                    </Button>
                    <Button variant='danger' onClick={confirm}>
                        {view?.confirmLabel ?? 'Supprimer'}
                    </Button>
                </>
            }
        />
    );
}
