import { Avatar, useWorkspaceMembers } from 'deveye-sdk-client';
import type { MinimalUser } from '@deveye/types';
import styles from './style.module.css';

/**
 * Le libellé d'un membre que l'espace actif ne connaît pas : venu de l'espace
 * d'origine d'un projet projeté, ou parti. Exporté pour le sélecteur d'assigné,
 * qui doit nommer sa valeur courante sans la proposer.
 */
export const HIDDEN_MEMBER_LABEL = 'Membre hors de cet espace';

/** Un identifiant à `null` : le compte a été supprimé (`ON DELETE SET NULL`). */
const DELETED_LABEL = 'Compte supprimé';

interface MemberProps {
    userId: number | null;
}

interface Resolved {
    user: MinimalUser | undefined;
    label: string;
    /** Un identifiant connu du serveur mais pas de cet espace. */
    hidden: boolean;
}

/**
 * Un assigné ou un auteur n'est nommé que s'il est membre de l'espace actif :
 * sur un projet projeté, nommer les membres de là-bas révélerait la composition
 * d'un espace où l'on n'est pas. Un inconnu se rend masqué, avatar neutre.
 */
function useMember(userId: number | null): Resolved {
    const members = useWorkspaceMembers();
    const user = userId === null ? undefined : members.find((m) => m.id === userId);
    if (user) return { user, label: user.username, hidden: false };
    return userId === null
        ? { user: undefined, label: DELETED_LABEL, hidden: false }
        : { user: undefined, label: HIDDEN_MEMBER_LABEL, hidden: true };
}

export function MemberAvatar({ userId, size }: MemberProps & { size?: number }) {
    const { user, label } = useMember(userId);
    return <Avatar user={user} size={size} title={label} />;
}

export function MemberName({ userId }: MemberProps) {
    const { label, hidden } = useMember(userId);
    return (
        <span className={hidden ? styles.memberHidden : undefined} title={hidden ? label : undefined}>
            {label}
        </span>
    );
}
