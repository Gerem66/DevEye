import type { MinimalUser } from '@deveye/types';
import { avatarSrc } from '@/Features/Profile/avatar';
import styles from './Avatar.module.css';

interface AvatarProps {
    user: MinimalUser | undefined;
    /** Taille en pixels ; la pastille est carrée. */
    size?: number;
    title?: string;
}

/**
 * Pastille d'identité d'un membre : son avatar, ou l'image de repli tant qu'il
 * n'en a pas posé. `user` peut être absent : un compte supprimé ne doit pas
 * casser le rendu.
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
    return <img className={styles.avatar} style={style} src={avatarSrc(user.avatar)} alt={label} title={label} />;
}

export default Avatar;
