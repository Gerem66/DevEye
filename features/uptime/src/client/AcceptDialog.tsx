import { useEffect, useState } from 'react';
import { Button, ChoiceCards, Dialog, DialogCancelButton, settingsStyles as shell } from 'deveye-sdk-client';

type Choice = 'update' | 'repaired';

interface AcceptDialogProps {
    open: boolean;
    /** Un écart est constaté : il faut dire ce qu'il était. Sans référence encore, il n'y a rien à dire. */
    drift: boolean;
    onClose: () => void;
    /** `repaint` : une mise à jour voulue, dont les mesures en échec repassent au vert. */
    onAccept: (repaint: boolean) => void;
}

/**
 * Prendre ce que le site sert maintenant comme référence. Face à un écart,
 * deux lectures qui n'ont pas le même effet sur la disponibilité : une mise à
 * jour qu'on reconnaît, ou un site qu'on vient de réparer après une attaque.
 */
export function AcceptDialog({ open, drift, onClose, onAccept }: AcceptDialogProps) {
    const [choice, setChoice] = useState<Choice>('update');

    useEffect(() => {
        if (open) setChoice('update');
    }, [open]);

    const repaint = drift && choice === 'update';
    const submit = () => {
        onAccept(repaint);
        onClose();
    };

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title='Accepter la version actuelle ?'
            description={
                drift
                    ? 'Les fichiers que le site sert à cet instant deviennent la référence, et l’écart en cours est clos. L’incident reste dans la liste ; dites ce qu’il était.'
                    : 'Les fichiers que le site sert à cet instant deviennent la référence.'
            }
            width={520}
            onSubmit={submit}
            footer={
                <>
                    <DialogCancelButton />
                    <Button onClick={submit}>
                        {drift ? (repaint ? 'Remettre au vert' : 'Garder en rouge') : 'Accepter'}
                    </Button>
                </>
            }
        >
            {drift && (
                <div className={shell.section}>
                    <ChoiceCards
                        aria-label='Ce qu’est l’écart'
                        value={choice}
                        onChange={setChoice}
                        options={[
                            {
                                value: 'update',
                                label: 'C’est une mise à jour',
                                icon: 'icon-refresh',
                                description:
                                    'Les mesures que l’écart tenait en échec repassent au vert : la disponibilité n’en garde pas trace.'
                            },
                            {
                                value: 'repaired',
                                label: 'Le site a été réparé',
                                icon: 'icon-wrench',
                                description:
                                    'Les mesures en échec restent rouges : la disponibilité garde la trace de l’attaque.'
                            }
                        ]}
                    />
                </div>
            )}
        </Dialog>
    );
}

export default AcceptDialog;
