import { SecurityTierChoice, Term, useActiveWorkspace } from 'deveye-sdk-client';

import type { DatabaseSecurityTier } from '../contracts/domain';

/** Ce qu'une base protégée ne fait pas, dit partout de la même façon. */
export const GUARDED_IDLE =
    'Une base protégée par mot de passe n’a ni relevé automatique ni alerte : le serveur ne peut la joindre qu’en votre présence.';

interface DatabaseTierChoiceProps {
    value: DatabaseSecurityTier;
    onChange: (tier: DatabaseSecurityTier) => void;
    disabled?: boolean;
    pending?: DatabaseSecurityTier | null;
    /** À la création : le choix conseillé est désigné, et l'écran dit où il se reprend. */
    advise?: boolean;
}

/**
 * Le choix de protection d'une base, identique à sa création et dans l'onglet
 * Chiffrement de ses réglages. Seuls ses deux secrets changent d'étage : ce que
 * chaque carte dit garder lisible l'est vraiment.
 */
export function DatabaseTierChoice({ value, onChange, disabled, pending, advise }: DatabaseTierChoiceProps) {
    const workspace = useActiveWorkspace();
    return (
        <SecurityTierChoice
            aria-label='Protection de la base'
            value={value}
            onChange={onChange}
            disabled={disabled}
            pending={pending}
            unavailable={
                workspace?.kind === 'personal'
                    ? undefined
                    : 'Une base protégée n’existe que dans votre espace personnel : dans un espace partagé, elle serait lisible par tous les membres.'
            }
            advise={
                advise &&
                'Ce choix se change quand vous voulez, dans les réglages de la base, onglet Chiffrement : rien n’est définitif ici.'
            }
            open={
                <p>
                    Relevée automatiquement, surveillée par ses alertes, et utilisable par les autres fonctionnalités :
                    une sauvegarde, un indicateur de projet. En contrepartie, le serveur garde de quoi s’y connecter à
                    tout moment.
                </p>
            }
            guarded={
                <p>
                    Son mot de passe et le secret de son accès sont protégés par le{' '}
                    <Term id='passwordEncryption'>chiffrement par mot de passe</Term> : une fois votre session
                    verrouillée, le serveur ne peut plus s’y connecter. En contrepartie, elle n’a ni relevé automatique
                    ni alerte, et ne peut être la source ni d’une sauvegarde ni d’un indicateur de projet. Son nom, son
                    hôte et son dernier relevé restent lisibles par le serveur.
                </p>
            }
        />
    );
}
