import { useSourceUrl } from '@/stores/sourceUrl';
import { CREDITS } from './credits';

import styles from './AboutContent.module.css';

export default function CreditsTab() {
    const sourceUrl = useSourceUrl();

    return (
        <>
            <p>
                Le cœur de DevEye est un logiciel libre, sous licence <strong>AGPL-3.0</strong> : vous pouvez en lire le
                code, le modifier et le redistribuer aux mêmes conditions. Les types partagés avec les modules sont sous
                licence MIT.
                {sourceUrl && (
                    <>
                        {' '}
                        <a href={sourceUrl} target='_blank' rel='noopener noreferrer' className={styles.inlineLink}>
                            Voir le code source
                        </a>
                    </>
                )}
            </p>

            {CREDITS.map((group) => (
                <div key={group.title}>
                    <p className={styles.sectionTitle}>{group.title}</p>
                    <ul className={styles.credits}>
                        {group.items.map((item) => (
                            <li key={item.name} className={styles.credit}>
                                <strong>{item.name}</strong>
                                <span className={styles.creditPurpose}>{item.purpose}</span>
                                <span className={styles.creditLicense}>{item.license}</span>
                            </li>
                        ))}
                    </ul>
                </div>
            ))}
        </>
    );
}
