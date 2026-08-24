import type { AudienceFunnel } from '@deveye/types';

import { Button, Dialog } from '@/Components';
import { formatCount, formatPercent } from './format';
import FunnelSteps from './Stats/FunnelSteps';
import styles from './style.module.css';

interface FunnelDetailDialogProps {
    /** `null` = fermé. */
    funnel: AudienceFunnel | null;
    canWrite: boolean;
    onClose: () => void;
    onEdit: () => void;
}

/**
 * Le détail d'un entonnoir, ouvert depuis sa barre.
 *
 * La barre compacte répond à « est-ce que ça passe ? » ; cette fenêtre répond à
 * « où exactement, et combien ». Séparer les deux est ce qui permet à la liste
 * de rester lisible quand un site porte cinq entonnoirs : cinq détails empilés
 * auraient rempli l'écran d'une information qu'on ne consulte qu'une à la fois.
 */
export function FunnelDetailDialog({ funnel, canWrite, onClose, onEdit }: FunnelDetailDialogProps) {
    const entered = funnel?.steps[0]?.sessions ?? 0;
    const done = funnel?.steps[funnel.steps.length - 1]?.sessions ?? 0;

    return (
        <Dialog
            open={funnel !== null}
            onClose={onClose}
            title={funnel?.name ?? ''}
            description={
                funnel && entered > 0
                    ? `${formatCount(entered)} visites entrées, ${formatCount(done)} arrivées au bout — ${formatPercent(
                          done / entered
                      )}.`
                    : 'Aucune visite n’est entrée dans cet entonnoir sur cette période.'
            }
            width={620}
            onSubmit={onClose}
            footer={
                <>
                    {canWrite && (
                        <Button variant='ghost' icon='edit' onClick={onEdit}>
                            Modifier
                        </Button>
                    )}
                    <Button variant='secondary' onClick={onClose}>
                        Fermer
                    </Button>
                </>
            }
        >
            {funnel && (
                <div className={styles.funnelDetail}>
                    <FunnelSteps funnel={funnel} />
                    <p className={styles.hint}>
                        Une visite compte pour une marche si elle a franchi toutes les précédentes,{' '}
                        <strong>dans cet ordre</strong>.
                    </p>
                </div>
            )}
        </Dialog>
    );
}

export default FunnelDetailDialog;
