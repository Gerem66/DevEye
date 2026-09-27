import type { MinimalUser } from '@deveye/types';

import Avatar from '@/Components/Avatar/Avatar';
import { USER_COLOR_OPTIONS, userColorVar } from '@/Features/Profile/userColors';
import { Specimen, Variant } from '../Specimen';
import styles from '../Gallery.module.css';

const SAMPLE = (color: MinimalUser['color']): MinimalUser => ({
    id: 1,
    email: 'camille@exemple.fr',
    username: 'Camille',
    avatar: '',
    color,
    lastLogin: 0,
    created: 0
});

export default function Identity() {
    return (
        <>
            <Specimen title='Avatar' note='Sans image, l’initiale sur la couleur du compte.'>
                {[24, 32, 48].map((size) => (
                    <Variant key={size} label={`${size} px`}>
                        <Avatar user={SAMPLE('blue')} size={size} />
                    </Variant>
                ))}
            </Specimen>
            <Specimen title='Couleurs de compte' note='La palette d’identité, par ses jetons --user-*.'>
                {USER_COLOR_OPTIONS.map((option) => (
                    <Variant key={option.value} label={option.label}>
                        <span className={styles.colorDot} style={{ background: userColorVar(option.value) }} />
                        <Avatar user={SAMPLE(option.value)} size={32} />
                    </Variant>
                ))}
            </Specimen>
        </>
    );
}
