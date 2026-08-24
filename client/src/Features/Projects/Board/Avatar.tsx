import type { MinimalUser } from '@deveye/types';
import { userColorVar } from '@/Features/Profile/userColors';
import styles from '../style.module.css';

interface AvatarProps {
    user: MinimalUser | undefined;
    /** Taille en pixels ; la pastille est carrée. */
    size?: number;
    title?: string;
}

/**
 * Pastille d'identité d'un membre : son avatar s'il en a un, sinon son initiale
 * sur sa **couleur de compte** — la même que celle de la présence en direct, de
 * sorte qu'une personne garde une seule couleur dans toute l'application.
 *
 * `user` peut être absent : un compte supprimé laisse `assigneeUserId` à null et
 * un auteur inconnu ne doit pas casser le rendu d'une carte.
 */
export function Avatar({ user, size = 22, title }: AvatarProps) {
    const label = title ?? user?.username ?? 'Compte supprimé';
    const style = { width: size, height: size, fontSize: Math.round(size * 0.45) };

    if (!user) {
        return (
            <span className={`${styles.avatar} ${styles.avatarGhost}`} style={style} title={label}>
                ?
            </span>
        );
    }
    if (user.avatar) {
        return <img className={styles.avatar} style={style} src={user.avatar} alt={label} title={label} />;
    }
    return (
        <span
            className={styles.avatar}
            style={{ ...style, background: userColorVar(user.color) }}
            title={label}
            aria-label={label}
        >
            {user.username.slice(0, 1).toUpperCase()}
        </span>
    );
}

export default Avatar;
