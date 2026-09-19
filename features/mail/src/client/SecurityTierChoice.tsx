import { ChoiceCards, useSecrecy } from 'deveye-sdk-client';

import type { MailSecurityTier } from '../contracts/domain';

interface SecurityTierChoiceProps {
    value: MailSecurityTier;
    onChange: (tier: MailSecurityTier) => void;
    disabled?: boolean;
    pending?: MailSecurityTier | null;
}

/**
 * Le choix de protection d'une boîte, identique sur les deux surfaces qui le
 * proposent : le formulaire de création et l'onglet Chiffrement des réglages.
 *
 * Sans chiffrement par mot de passe sur le compte, une boîte « protégée »
 * resterait lisible par le serveur : le choix s'explique au lieu de s'offrir.
 */
export function SecurityTierChoice({ value, onChange, disabled, pending }: SecurityTierChoiceProps) {
    const secrecy = useSecrecy();

    return (
        <ChoiceCards
            aria-label='Protection de la boîte'
            value={value}
            onChange={onChange}
            disabled={disabled}
            pending={pending}
            options={[
                {
                    value: 'open',
                    label: 'Ouverte',
                    icon: 'icon-unlock',
                    description:
                        'Relevée automatiquement en arrière-plan, et utilisable par les autres fonctionnalités, ' +
                        'par exemple pour envoyer les alertes d’Uptime. En contrepartie, le serveur garde de quoi ' +
                        'la lire à tout moment.'
                },
                {
                    value: 'guarded',
                    label: 'Protégée',
                    icon: 'icon-lock',
                    description:
                        'Chiffrée avec votre mot de passe : une fois votre session verrouillée, ni le serveur ni ' +
                        'aucune autre fonctionnalité ne peut la lire. En contrepartie, elle ne se relève que ' +
                        'lorsque vous la consultez, et ne peut envoyer aucune alerte.',
                    unavailable:
                        secrecy.enabled || value === 'guarded'
                            ? undefined
                            : 'Activez d’abord le chiffrement par mot de passe, dans Sécurité.'
                }
            ]}
        />
    );
}
