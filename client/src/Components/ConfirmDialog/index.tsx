import { useRef, type ReactNode } from 'react';

import Button from '@/Components/Button';
import { Dialog } from '@/Components/Dialog';

/**
 * La confirmation d'une action destructive, une seule pour toute l'app :
 * `Dialog` statique, Entrée câblée sur l'action principale via `onSubmit`,
 * « Annuler » en secondaire et l'action en `danger`. `Dialog` s'inscrit dans
 * la pile `useDismissLayer`, donc Échap ferme d'abord la confirmation.
 */

export interface ConfirmRequest {
    title: string;
    /** Ce que l'action va faire, et à quoi. `ReactNode` et non `string` : une
     *  suppression qui emporte des liens doit pouvoir les nommer dans une liste. */
    description?: ReactNode;
    confirmLabel?: string;
    /** `primary` pour une action réversible ; `danger` par défaut. */
    tone?: 'danger' | 'primary';
    /** Suivi de `onClose` : une autre demande posée d'ici serait aussitôt refermée,
     *  une seconde confirmation passe par un second `ConfirmDialog`. */
    onConfirm: () => void;
}

export interface ConfirmDialogProps {
    /** La demande en cours, ou `null` quand rien n'est à confirmer. */
    request: ConfirmRequest | null;
    onClose: () => void;
    busy?: boolean;
}

export function ConfirmDialog({ request, onClose, busy = false }: ConfirmDialogProps): React.ReactElement {
    /** La dernière demande, gardée le temps de l'animation de sortie : rendre
     *  `request` directement ferait clignoter un titre vide. */
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
                    <Button variant='secondary' onClick={onClose} disabled={busy}>
                        Annuler
                    </Button>
                    <Button variant={view?.tone ?? 'danger'} onClick={confirm} disabled={busy}>
                        {view?.confirmLabel ?? 'Supprimer'}
                    </Button>
                </>
            }
        />
    );
}

export default ConfirmDialog;
