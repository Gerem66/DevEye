import { Avatar, useWorkspaceMembers } from 'deveye-sdk-client';
import type { MinimalUser } from '@deveye/types';
import styles from './style.module.css';

/**
 * Le libellé d'un membre que l'espace actif ne connaît pas : un membre de
 * l'espace d'origine d'un projet projeté, ou quelqu'un qui a quitté cet
 * espace. Dans les deux cas on ne le nomme pas, on dit seulement qu'il est
 * hors d'ici (décision de Gerem : un nom ne s'affiche que s'il est
 * accessible depuis l'espace qu'on charge).
 *
 * Exporté pour le sélecteur d'assigné, qui doit pouvoir nommer sa valeur
 * courante sans la proposer (voir `CardDialog`).
 */
export const HIDDEN_MEMBER_LABEL = 'Membre hors de cet espace';

/** Un identifiant à `null` : le compte a été supprimé (`ON DELETE SET NULL`). */
const DELETED_LABEL = 'Compte supprimé';

interface MemberProps {
    /** L'assigné ou l'auteur ; `null` = compte supprimé. */
    userId: number | null;
}

interface Resolved {
    user: MinimalUser | undefined;
    label: string;
    /** Un identifiant connu du serveur mais pas de cet espace : on le masque. */
    hidden: boolean;
}

/**
 * Qui est ce membre, vu d'ici.
 *
 * Un assigné ou un auteur n'est nommé que s'il est **membre de l'espace
 * actif**. Sur un projet projeté depuis un autre espace, les cartes et les
 * messages portent les identifiants des membres de là-bas ; les nommer ici
 * reviendrait à révéler la composition d'un espace où l'on n'est pas. Un
 * identifiant inconnu s'affiche donc masqué, avatar neutre et libellé fixe,
 * partout où un membre est rendu. Le compte supprimé garde son libellé propre :
 * ce n'est pas une frontière, c'est une absence.
 */
function useMember(userId: number | null): Resolved {
    const members = useWorkspaceMembers();
    const user = userId === null ? undefined : members.find((m) => m.id === userId);
    if (user) return { user, label: user.username, hidden: false };
    return userId === null
        ? { user: undefined, label: DELETED_LABEL, hidden: false }
        : { user: undefined, label: HIDDEN_MEMBER_LABEL, hidden: true };
}

/**
 * La pastille d'identité d'un membre, ou une pastille neutre s'il n'est pas
 * d'ici. L'infobulle porte le libellé dans les deux cas.
 */
export function MemberAvatar({ userId, size }: MemberProps & { size?: number }) {
    const { user, label } = useMember(userId);
    return <Avatar user={user} size={size} title={label} />;
}

/** Le nom d'un membre, ou le libellé masqué s'il n'est pas d'ici. */
export function MemberName({ userId }: MemberProps) {
    const { label, hidden } = useMember(userId);
    return (
        <span className={hidden ? styles.memberHidden : undefined} title={hidden ? label : undefined}>
            {label}
        </span>
    );
}
