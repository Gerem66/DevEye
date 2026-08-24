import { useRef, type ReactNode } from 'react';

import Button from '@/Components/Button';
import { Dialog } from '@/Components/Dialog';

/**
 * La confirmation d'une action destructive — **une seule pour toute l'app**.
 *
 * Il en existait quatre quasi identiques : `Features/Osint/ConfirmDialog`, et
 * les `ConfirmPopup` de Notes, Mail et CloudSync, plus des `Dialog` posés à la
 * main dans Backup et Clients. Toutes disaient la même chose de la même façon,
 * à ceci près que certaines avaient le garde-fou d'animation ci-dessous et
 * d'autres non — c'est-à-dire que le titre y clignotait à la fermeture.
 *
 * Forme reprise de celle d'Osint, la plus aboutie : `Dialog` statique, Entrée
 * câblée sur l'action principale via `onSubmit`, « Annuler » en secondaire et
 * l'action en `danger`. `Dialog` passe par un portail en `z-modal` et s'inscrit
 * dans la pile `useDismissLayer`, donc la boîte se pose au-dessus de ce qui
 * l'ouvre et Échap ferme d'abord la confirmation.
 */

export interface ConfirmRequest {
    title: string;
    /**
     * Ce que l'action va faire, et à quoi.
     *
     * `ReactNode` et non `string` : une suppression qui emporte des liens doit
     * pouvoir les **nommer** dans une liste. « Êtes-vous sûr ? » sans dire de
     * quoi ne fait pas confirmer, il fait cliquer.
     */
    description?: ReactNode;
    confirmLabel?: string;
    /** `secondary` pour une action réversible ; `danger` par défaut. */
    tone?: 'danger' | 'primary';
    onConfirm: () => void;
}

export interface ConfirmDialogProps {
    /** La demande en cours, ou `null` quand rien n'est à confirmer. */
    request: ConfirmRequest | null;
    onClose: () => void;
    busy?: boolean;
}

export function ConfirmDialog({ request, onClose, busy = false }: ConfirmDialogProps): React.ReactElement {
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
