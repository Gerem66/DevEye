import { Hint } from '@/Components/Hint';

import styles from './OrganizeButton.module.css';

export interface OrganizeButtonProps {
    /** L'accueil est en organisation : le bouton la valide au lieu de l'ouvrir. */
    organizing: boolean;
    onToggle: () => void;
    /** La bulle de présentation, tant que le compte ne l'a pas écartée. */
    hinted: boolean;
    onDismissHint: () => void;
}

/**
 * Le raccourci vers l'organisation de l'accueil, en bas à droite : le pendant
 * du bouton de signalement, pour qui peut modifier la disposition de l'espace.
 */
export function OrganizeButton({ organizing, onToggle, hinted, onDismissHint }: OrganizeButtonProps) {
    const label = organizing ? 'Valider l’organisation' : 'Organiser l’accueil';
    return (
        <>
            {hinted && (
                <Hint title='Un accueil à votre image' placement='corner-right' onDismiss={onDismissHint}>
                    Ce bouton, comme « Organiser l’accueil » dans le menu de l’espace, permet de ranger vos tuiles et
                    d’ajouter des fonctionnalités.
                </Hint>
            )}
            <button
                type='button'
                className={`${styles.trigger} ${hinted ? styles.triggerHinted : ''} ${organizing ? styles.triggerDone : ''}`}
                onClick={onToggle}
                title={label}
                aria-label={label}
            >
                <span className={`icon ${organizing ? 'icon-v' : 'icon-edit'}`} />
            </button>
        </>
    );
}

export default OrganizeButton;
