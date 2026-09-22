import { useMemo } from 'react';
import { Avatar, useWorkspaceMembers, type SearchSelectOption } from 'deveye-sdk-client';
import type { MinimalUser } from '@deveye/types';
import { compareFr } from './api';
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

/**
 * Les choix d'un sélecteur d'assigné : « Personne », puis les membres d'ici par
 * ordre alphabétique. L'assigné courant peut n'en être pas (projet projeté) : il
 * figure alors en tête, nommé sans être révélé, pour que la valeur se lise.
 */
export function useAssigneeOptions(members: readonly MinimalUser[], current: number | null): SearchSelectOption[] {
    return useMemo(() => {
        const options: SearchSelectOption[] = [{ value: '', label: 'Personne' }];
        if (current !== null && !members.some((m) => m.id === current)) {
            options.push({ value: String(current), label: HIDDEN_MEMBER_LABEL });
        }
        for (const m of [...members].sort((a, b) => compareFr(a.username, b.username))) {
            options.push({ value: String(m.id), label: m.username, prefix: <Avatar user={m} size={18} /> });
        }
        return options;
    }, [members, current]);
}

interface MemberStackProps {
    /** L'assigné de la tâche : en tête de pile, à droite. */
    userId: number | null;
    /** Les assignés des sous-tâches, dans l'ordre de la liste. */
    others: readonly (number | null)[];
    size: number;
    /** Bulles montrées avant « +N ». */
    max?: number;
    /** La pile s'étale au survol. Pas sur une barre de frise, trop étroite. */
    spread?: boolean;
}

/**
 * Qui porte une tâche et ses sous-tâches, chacun une fois. Une seule annonce pour
 * toute la pile : bulle par bulle, un lecteur d'écran répéterait quatre images.
 */
export function MemberStack({ userId, others, size, max = 4, spread = false }: MemberStackProps) {
    const members = useWorkspaceMembers();
    const ids = [...new Set([userId, ...others].filter((id): id is number => id !== null))];
    if (ids.length === 0) return null;

    const nameOf = (id: number) => members.find((m) => m.id === id)?.username;
    const sentence = (list: number[]): string => {
        const named = list.map(nameOf).filter((n): n is string => n !== undefined);
        const hidden = list.length - named.length;
        if (hidden > 0)
            named.push(hidden === 1 ? 'un membre hors de cet espace' : `${hidden} membres hors de cet espace`);
        return named.join(', ');
    };
    const helpers = ids.filter((id) => id !== userId);
    const label = [
        userId !== null ? `Tâche : ${sentence([userId])}.` : null,
        helpers.length > 0 ? `Sous-tâches : ${sentence(helpers)}.` : null
    ]
        .filter(Boolean)
        .join(' ');

    const shown = ids.slice(0, max);
    const more = ids.length - shown.length;
    return (
        <span
            className={spread ? `${styles.stack} ${styles.stackSpread}` : styles.stack}
            role='img'
            aria-label={label}
            title={label}
            style={{ height: size }}
        >
            {shown.map((id) => (
                <span key={id} className={styles.stackBubble} aria-hidden='true'>
                    <Avatar user={members.find((m) => m.id === id)} size={size} title='' />
                </span>
            ))}
            {more > 0 && (
                <span className={styles.stackMore} aria-hidden='true' style={{ minWidth: size, height: size }}>
                    +{more}
                </span>
            )}
        </span>
    );
}
