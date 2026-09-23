import { ChoiceCards, Term, useSecrecy } from 'deveye-sdk-client';

import type { MailSecurityTier } from '../contracts/domain';
import styles from './style.module.css';

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
 *
 * Sans chiffrement par mot de passe sur le compte, une boîte « protégée »
 * resterait lisible par le serveur : le choix s'explique au lieu de s'offrir.
 */
export function SecurityTierChoice({ value, onChange, disabled, pending, onPick, advise }: SecurityTierChoiceProps) {
    const secrecy = useSecrecy();

    return (
        <>
            <ChoiceCards
                aria-label='Protection de la boîte'
                value={value}
                onChange={onChange}
                disabled={disabled}
                pending={pending}
                onPick={onPick}
                options={[
                    {
                        value: 'open',
                        label: 'Ouverte',
                        hint: advise ? '(recommandé)' : undefined,
                        icon: 'icon-unlock',
                        description: (
                            <p>
                                Relevée automatiquement en arrière-plan, et utilisable par les autres fonctionnalités,
                                par exemple pour envoyer les alertes d’Uptime. En contrepartie, le serveur garde de quoi
                                la lire à tout moment : ce n’est pas du <Term id='zeroKnowledge'>zero knowledge</Term>.
                            </p>
                        )
                    },
                    {
                        value: 'guarded',
                        label: 'Protégée',
                        icon: 'icon-lock',
                        description: (
                            <p>
                                Chiffrée avec votre mot de passe, en <Term id='zeroKnowledge'>zero knowledge</Term> :
                                une fois votre session verrouillée, ni le serveur ni aucune autre fonctionnalité ne peut
                                la lire. En contrepartie, elle ne se relève que lorsque vous la consultez, et ne peut
                                envoyer aucune alerte.
                            </p>
                        ),
                        unavailable:
                            secrecy.enabled || value === 'guarded'
                                ? undefined
                                : 'Activez d’abord le chiffrement par mot de passe, dans Sécurité.'
                    }
                ]}
            />
            {advise && (
                <p className={styles.tierNote}>
                    Ce choix se change quand vous voulez, dans les réglages de la boîte : rien n’est définitif ici.
                </p>
            )}
        </>
    );
}
