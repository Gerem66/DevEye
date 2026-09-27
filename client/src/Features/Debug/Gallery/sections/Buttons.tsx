import Button from '@/Components/Button';
import CopyButton from '@/Components/CopyButton';
import SaveButton from '@/Components/FeatureSettings/SaveButton';
import { Specimen, useGalleryDisabled, Variant } from '../Specimen';

const VARIANTS = ['primary', 'secondary', 'danger', 'ghost'] as const;

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export default function Buttons() {
    const disabled = useGalleryDisabled();
    return (
        <>
            <Specimen title='Button' note='Quatre variantes : texte seul, icône et texte, icône seule, désactivé.'>
                {VARIANTS.map((variant) => (
                    <Variant key={variant} label={variant}>
                        <Button variant={variant} disabled={disabled}>
                            Enregistrer
                        </Button>
                        <Button variant={variant} icon='plus' disabled={disabled}>
                            Ajouter
                        </Button>
                        <Button variant={variant} icon='settings' disabled={disabled} aria-label='Réglages' />
                        <Button variant={variant} disabled>
                            Indisponible
                        </Button>
                    </Variant>
                ))}
            </Specimen>
            <Specimen title='SaveButton' note='« Enregistrement… » pendant l’aller-retour, puis « Enregistré ».'>
                <Variant label='inline'>
                    <SaveButton placement='inline' disabled={disabled} onSave={() => pause(800)} />
                    <SaveButton placement='inline' variant='secondary' disabled={disabled} onSave={() => pause(800)}>
                        Appliquer
                    </SaveButton>
                </Variant>
            </Specimen>
            <Specimen title='CopyButton'>
                <Variant label='valeur'>
                    <CopyButton value='https://app.deveye.fr' />
                    <CopyButton value='pk_exemple' label='Copier la clé' />
                </Variant>
            </Specimen>
        </>
    );
}
