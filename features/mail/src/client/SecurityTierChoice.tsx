import { SecurityTierChoice as TierChoice, Term } from 'deveye-sdk-client';

import type { MailSecurityTier } from '../contracts/domain';

interface SecurityTierChoiceProps {
    value: MailSecurityTier;
    onChange: (tier: MailSecurityTier) => void;
    disabled?: boolean;
    pending?: MailSecurityTier | null;
    onPick?: (tier: MailSecurityTier) => void;
    /**
     * À la création : le choix conseillé est désigné, et l'écran dit qu'il se
     * reprend. Inutile dans les réglages d'une boîte, où l'on est précisément
     * en train de le reprendre.
     */
    advise?: boolean;
}

/**
 * Le choix de protection d'une boîte, identique sur les deux surfaces qui le
 * proposent : le formulaire de création et l'onglet Chiffrement des réglages.
 * Ce qu'une boîte gagne et perd à chaque étage est dit ici ; le reste est le
 * choix d'étage du SDK.
 */
export function SecurityTierChoice({ value, onChange, disabled, pending, onPick, advise }: SecurityTierChoiceProps) {
    return (
        <TierChoice
            aria-label='Protection de la boîte'
            value={value}
            onChange={onChange}
            disabled={disabled}
            pending={pending}
            onPick={onPick}
            advise={
                advise &&
                'Ce choix se change quand vous voulez, dans les réglages de la boîte : rien n’est définitif ici.'
            }
            open={
                <p>
                    Relevée automatiquement en arrière-plan, et utilisable par les autres fonctionnalités, par exemple
                    pour envoyer les alertes d’Uptime. En contrepartie, le serveur garde de quoi la lire à tout moment.
                </p>
            }
            guarded={
                <p>
                    Protégée par le <Term id='passwordEncryption'>chiffrement par mot de passe</Term> : une fois votre
                    session verrouillée, ni le serveur ni aucune autre fonctionnalité ne peut la lire. En contrepartie,
                    elle ne se relève que lorsque vous la consultez, et ne peut envoyer aucune alerte.
                </p>
            }
        />
    );
}
