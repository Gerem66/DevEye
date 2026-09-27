import { useState } from 'react';

import Button from '@/Components/Button';
import { ConfirmDialog, type ConfirmRequest } from '@/Components/ConfirmDialog';
import { Dialog, DialogCancelButton } from '@/Components/Dialog';
import Popup, { ClosePopup, OpenPopup } from '@/Components/Popup';
import { Specimen, useGalleryDisabled, Variant } from '../Specimen';
import styles from '../Gallery.module.css';

const POPUP_ID = 'debug-gallery-popup';

export default function Overlays() {
    const disabled = useGalleryDisabled();
    const [dialog, setDialog] = useState<'small' | 'large' | null>(null);
    const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
    const [outcome, setOutcome] = useState<string | null>(null);

    const openPopup = async (): Promise<void> => {
        const result = await OpenPopup<{ answer: string }>(POPUP_ID);
        setOutcome(result ? `La popup a rendu « ${result.answer} ».` : 'La popup a été fermée sans réponse.');
    };

    return (
        <>
            <Specimen title='Dialog' note='Échap ferme la couche la plus haute ; Entrée déclenche l’action principale.'>
                <Variant label='tailles'>
                    <Button variant='secondary' disabled={disabled} onClick={() => setDialog('small')}>
                        Petite
                    </Button>
                    <Button variant='secondary' disabled={disabled} onClick={() => setDialog('large')}>
                        Grande, avec pied
                    </Button>
                </Variant>
            </Specimen>
            <Specimen title='ConfirmDialog'>
                <Variant label='danger et primaire'>
                    <Button
                        variant='danger'
                        disabled={disabled}
                        onClick={() =>
                            setConfirm({
                                title: 'Supprimer ce site ?',
                                description: 'Ses mesures partent avec lui.',
                                confirmLabel: 'Supprimer',
                                onConfirm: () => setOutcome('Suppression confirmée.')
                            })
                        }
                    >
                        Supprimer
                    </Button>
                    <Button
                        variant='secondary'
                        disabled={disabled}
                        onClick={() =>
                            setConfirm({
                                title: 'Relancer la synchronisation ?',
                                tone: 'primary',
                                confirmLabel: 'Relancer',
                                onConfirm: () => setOutcome('Relance confirmée.')
                            })
                        }
                    >
                        Relancer
                    </Button>
                </Variant>
            </Specimen>
            <Specimen title='Popup' note='La couche impérative : OpenPopup attend ce que ClosePopup lui rend.'>
                <Variant label='OpenPopup'>
                    <Button variant='secondary' disabled={disabled} onClick={() => void openPopup()}>
                        Ouvrir
                    </Button>
                </Variant>
            </Specimen>
            {outcome && <p className={styles.demoText}>{outcome}</p>}

            <Dialog
                open={dialog !== null}
                onClose={() => setDialog(null)}
                title={dialog === 'large' ? 'Une grande fenêtre' : 'Une petite fenêtre'}
                description='Le texte d’introduction, sous le titre.'
                width={dialog === 'large' ? 720 : 420}
                footer={
                    dialog === 'large' ? (
                        <>
                            <DialogCancelButton variant='secondary'>Annuler</DialogCancelButton>
                            <Button onClick={() => setDialog(null)}>Valider</Button>
                        </>
                    ) : undefined
                }
            >
                <p className={styles.demoText}>Le contenu de la fenêtre.</p>
            </Dialog>
            <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
            <Popup id={POPUP_ID} title='Popup impérative' width={420}>
                <p className={styles.demoText}>Choisissez une réponse : elle revient à qui a ouvert la popup.</p>
                <Button onClick={() => ClosePopup(POPUP_ID, { answer: 'oui' })}>Répondre « oui »</Button>
            </Popup>
        </>
    );
}
