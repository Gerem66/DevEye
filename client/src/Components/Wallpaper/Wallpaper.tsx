import { useTheme } from '@/stores/theme';
import styles from './Wallpaper.module.css';

/**
 * Fixed full-screen dashboard background. Default = accent-tinted gradient
 * (follows the chosen accent), overridable by a gradient preset or an image.
 * Single element, two modes — no JS repaint.
 */
export default function Wallpaper() {
    const { bgImage } = useTheme();
    return (
        <div className={styles.wallpaper} aria-hidden='true'>
            {bgImage && (
                <div
                    key={bgImage}
                    className={styles.image}
                    style={{ backgroundImage: `url("${bgImage.replace(/"/g, '%22')}")` }}
                />
            )}
        </div>
    );
}
