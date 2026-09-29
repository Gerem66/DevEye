import { LEGAL_LABELS, legalLinks } from '@/legal';
import { useSiteUrl } from '@/stores/siteUrl';
import { useSourceUrl } from '@/stores/sourceUrl';
import { useStatusPageHref } from '@/stores/statusPage';
import { visibleFeatureCatalog } from '../catalog';
import { CHANGELOG } from './changelog';
import { ChangeList, releaseDate } from './ChangelogTab';
import { countFeatureLinks } from './FeaturesTab';
import { useServiceCount } from './ServicesTab';
import type { AboutTab } from './AboutContent';

import styles from './AboutContent.module.css';

/** Au-delà, la carte renvoie à l'historique plutôt que de s'allonger. */
const LATEST_PREVIEW = 4;

function plural(n: number, one: string, many: string): string {
    return `${n} ${n > 1 ? many : one}`;
}

interface JumpProps {
    icon: string;
    title: string;
    detail: string;
    onClick: () => void;
}

function Jump({ icon, title, detail, onClick }: JumpProps) {
    return (
        <button type='button' className={styles.jump} onClick={onClick}>
            <span className={`icon icon-${icon} ${styles.jumpIcon}`} aria-hidden='true' />
            <span className={styles.jumpText}>
                <strong>{title}</strong>
                <span>{detail}</span>
            </span>
            <span className={`icon icon-chevron ${styles.jumpChevron}`} aria-hidden='true' />
        </button>
    );
}

function ExternalLink({ href, icon, children }: { href: string; icon: string; children: string }) {
    return (
        <a href={href} target='_blank' rel='noopener noreferrer' className={styles.outLink}>
            <span className={`icon icon-${icon}`} aria-hidden='true' />
            {children}
        </a>
    );
}

/** Ce qui se voit d'un coup d'œil ; le détail est dans les autres onglets. */
export default function OverviewTab({ onOpen }: { onOpen: (tab: AboutTab) => void }) {
    const siteUrl = useSiteUrl();
    const statusUrl = useStatusPageHref();
    const sourceUrl = useSourceUrl();
    const serviceCount = useServiceCount();
    const legal = siteUrl === null ? null : legalLinks(siteUrl);
    const latest = CHANGELOG.find((e) => e.version === __APP_VERSION__) ?? CHANGELOG[0];
    const catalog = visibleFeatureCatalog();
    const links = countFeatureLinks(catalog);
    const hasLinks = siteUrl !== null || statusUrl !== null || sourceUrl !== null;

    return (
        <>
            <p>
                DevEye est votre tableau de bord : appareils, fonctionnalités et raccourcis réunis sur un même accueil,
                que vous composez librement section par section.
            </p>

            {latest && (
                <section className={styles.latest}>
                    <p className={styles.releaseHead}>
                        <strong>Nouveautés de la version {latest.version}</strong>
                        <span>{releaseDate(latest.date)}</span>
                    </p>
                    <ChangeList changes={latest.changes.slice(0, LATEST_PREVIEW)} />
                    <button type='button' className={styles.more} onClick={() => onOpen('changelog')}>
                        Tout l’historique
                        <span className='icon icon-arrow' aria-hidden='true' />
                    </button>
                </section>
            )}

            <div className={styles.jumps}>
                <Jump
                    icon='list'
                    title='Fonctionnalités'
                    detail={`${plural(catalog.length, 'fonctionnalité', 'fonctionnalités')}, ${plural(links, 'lien', 'liens')} entre elles`}
                    onClick={() => onOpen('features')}
                />
                <Jump
                    icon='globe'
                    title='Services externes'
                    detail={`${plural(serviceCount, 'service', 'services')}, et ce qu’ils reçoivent`}
                    onClick={() => onOpen('services')}
                />
            </div>

            {hasLinks && (
                <div className={styles.outLinks}>
                    {siteUrl && (
                        <ExternalLink href={siteUrl} icon='home'>
                            Site de DevEye
                        </ExternalLink>
                    )}
                    {statusUrl && (
                        <ExternalLink href={statusUrl} icon='activity'>
                            État des services
                        </ExternalLink>
                    )}
                    {sourceUrl && (
                        <ExternalLink href={sourceUrl} icon='branch'>
                            Code source
                        </ExternalLink>
                    )}
                </div>
            )}

            {legal && (
                <div>
                    <p className={styles.sectionTitle}>Documents légaux</p>
                    <ul className={styles.legalLinks}>
                        {(Object.keys(LEGAL_LABELS) as (keyof typeof LEGAL_LABELS)[]).map((key) => (
                            <li key={key}>
                                <a href={legal[key]} target='_blank' rel='noopener noreferrer'>
                                    {LEGAL_LABELS[key]}
                                </a>
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </>
    );
}
