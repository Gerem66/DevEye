import type { ReactNode } from 'react';

import ChoiceCards from '@/Components/ChoiceCards';
import { useSecrecy } from '@/stores/secrecy';

import styles from './style.module.css';

/** Sous quelle clé un élément garde ce qu'il a de secret : celle que le serveur ouvre seul, ou celle du mot de passe. */
export type SecurityTier = 'open' | 'guarded';

export interface SecurityTierChoiceProps {
    /** Ce que le choix protège, pour qui ne voit pas l'écran : « Protection de la boîte ». */
    'aria-label': string;
    value: SecurityTier;
    onChange: (tier: SecurityTier) => void;
    disabled?: boolean;
    /** L'étage en cours d'application. */
    pending?: SecurityTier | null;
    onPick?: (tier: SecurityTier) => void;
    /** Ce que chaque étage permet et ce qu'il coûte, pour cet élément. */
    open: ReactNode;
    guarded: ReactNode;
    /**
     * À la création : le choix conseillé (l'étage ouvert) est désigné, et cette
     * phrase dit où il se reprend. Inutile là où l'on est en train de le reprendre.
     */
    advise?: ReactNode;
    /** Pourquoi l'étage protégé ne s'offre pas ici, quand ce n'est pas faute de chiffrement par mot de passe. */
    unavailable?: string;
    /** Les deux libellés, accordés à l'élément. Au féminin par défaut : une boîte, une base. */
    labels?: { open: string; guarded: string };
}

/**
 * Le choix de protection d'un élément dont le module laisse choisir l'étage,
 * le même sur toutes les surfaces qui le proposent : sa création, puis l'onglet
 * Chiffrement de ses réglages.
 *
 * Sans chiffrement par mot de passe sur le compte, un élément « protégé »
 * resterait lisible par le serveur : le choix s'explique au lieu de s'offrir.
 * Un élément déjà protégé le reste affiché tel quel, pour pouvoir le rouvrir,
 * et l'écran dit alors que sa protection ne tient plus.
 * Le serveur du module refuse de son côté ce que cette carte n'offre pas.
 */
export default function SecurityTierChoice({
    'aria-label': ariaLabel,
    value,
    onChange,
    disabled,
    pending,
    onPick,
    open,
    guarded,
    advise,
    unavailable,
    labels = { open: 'Ouverte', guarded: 'Protégée' }
}: SecurityTierChoiceProps) {
    const secrecy = useSecrecy();
    const refused =
        unavailable ??
        (secrecy.enabled ? undefined : 'Activez d’abord le chiffrement par mot de passe, dans Sécurité.');

    return (
        <>
            <ChoiceCards
                aria-label={ariaLabel}
                value={value}
                onChange={onChange}
                disabled={disabled}
                pending={pending}
                onPick={onPick}
                options={[
                    {
                        value: 'open',
                        label: labels.open,
                        hint: advise ? '(recommandé)' : undefined,
                        icon: 'icon-unlock',
                        description: open
                    },
                    {
                        value: 'guarded',
                        label: labels.guarded,
                        icon: 'icon-lock',
                        description: guarded,
                        unavailable: value === 'guarded' ? undefined : refused
                    }
                ]}
            />
            {value === 'guarded' && !secrecy.enabled && (
                <p className={styles.warning} role='alert'>
                    Le chiffrement par mot de passe est éteint sur votre compte : tant qu’il l’est, le serveur garde de
                    quoi lire ce que cet étage protège. Réactivez-le dans Sécurité, ou repassez à l’étage ouvert.
                </p>
            )}
            {advise && <p className={styles.note}>{advise}</p>}
        </>
    );
}
