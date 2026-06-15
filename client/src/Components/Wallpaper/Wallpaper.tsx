import { useWallpaper } from '@/stores/wallpaper';
import styles from './Wallpaper.module.css';

/**
 * Fixed full-screen dashboard background. Default = cyan/teal gradient.
 * When a wallpaper image is configured (Settings), it layers a "photo + glass"
 * background with a legibility scrim. Single element, two modes — no JS repaint.
 */
export default function Wallpaper() {
    const { image } = useWallpaper();
    return (
        <div className={styles.wallpaper} aria-hidden='true'>
            {image && (
                <div
                    key={image}
                    className={styles.image}
                    style={{ backgroundImage: `url("${image.replace(/"/g, '%22')}")` }}
                />
            )}
        </div>
    );
}
