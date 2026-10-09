import { useCallback, useEffect, useState } from 'react';
import type { CommandOutput } from '@deveye/types';

import { ws, WsError } from '@/api/ws';
import SideNav, { type SideNavItem } from '@/Components/FeatureSettings/SideNav';
import { StatusBadge } from '@/Components/StatusBadge';
import StickyHeader from '@/Components/StickyHeader';
import { useResourceVersion } from '@/stores/invalidation';
import Gallery from './Gallery/Gallery';
import BenchSection from './sections/BenchSection';
import E2eSection from './sections/E2eSection';
import MailSection from './sections/MailSection';
import TrackingSection from './sections/TrackingSection';
import styles from './Debug.module.css';

type SectionId = 'e2e' | 'bench' | 'mail' | 'tracking' | 'gallery';
type Overview = CommandOutput<'debug.overview'>;

const SECTIONS: SideNavItem<SectionId>[] = [
    { id: 'e2e', label: 'Parcours complets', icon: 'play' },
    { id: 'bench', label: 'Mesures', icon: 'clock' },
    { id: 'mail', label: 'Mails', icon: 'mail' },
    { id: 'tracking', label: 'Suivi d’usage', icon: 'activity' },
    { id: 'gallery', label: 'Composants', icon: 'appearance' }
];

const SECTION_KEY = 'deveye:debug-section';

function rememberedSection(): SectionId {
    try {
        const saved = localStorage.getItem(SECTION_KEY);
        return SECTIONS.some((s) => s.id === saved) ? (saved as SectionId) : 'e2e';
    } catch {
        return 'e2e';
    }
}

const ENVIRONMENT_LABEL: Record<Overview['instance']['environment'], string> = {
    dev: 'Développement',
    test: 'Test',
    prod: 'Production'
};

/**
 * Page « Tests et débogage » : vérifier ce serveur tel qu'il tourne, sans rien
 * y laisser. Réservée à l'administrateur global ; chaque commande est gardée
 * serveur.
 */
export default function FeatureDebug() {
    const [section, setSection] = useState<SectionId>(rememberedSection);
    const [overview, setOverview] = useState<Overview | null>(null);
    const [error, setError] = useState<string | null>(null);
    const version = useResourceVersion('debug.overview');

    const load = useCallback(async () => {
        try {
            setOverview(await ws.send('debug.overview', {}));
        } catch (e) {
            setError(
                e instanceof WsError && e.code === 'forbidden'
                    ? 'Accès réservé aux administrateurs.'
                    : 'Impossible de charger la page.'
            );
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load, version]);

    const select = (id: SectionId): void => {
        setSection(id);
        try {
            localStorage.setItem(SECTION_KEY, id);
        } catch {
            // Le choix ne sera pas retenu : sans conséquence.
        }
    };

    const active = overview?.activeRun ?? null;

    return (
        <div className={styles.container}>
            <StickyHeader>
                <header className={styles.header}>
                    <div className={styles.headerText}>
                        <h2 className={styles.title}>Tests et débogage</h2>
                        <p className={styles.subtitle}>Vérifier ce serveur tel qu’il tourne, sans rien y laisser.</p>
                    </div>
                    {overview && (
                        <div className={styles.instance}>
                            <StatusBadge tone={overview.instance.environment === 'prod' ? 'warning' : 'accent'}>
                                {ENVIRONMENT_LABEL[overview.instance.environment]}
                            </StatusBadge>
                            <span className={styles.instanceMeta}>
                                {overview.instance.origin} · v{overview.instance.version}
                            </span>
                        </div>
                    )}
                </header>
            </StickyHeader>

            {error && <div className={styles.errorBanner}>{error}</div>}

            <div className={styles.layout}>
                <SideNav items={SECTIONS} active={section} onSelect={select} label='Sections de la page' />
                <div className={styles.panel}>
                    {section === 'e2e' && <E2eSection activeRunId={active?.kind === 'e2e' ? active.id : null} />}
                    {section === 'bench' && <BenchSection activeRunId={active?.kind === 'bench' ? active.id : null} />}
                    {section === 'mail' && <MailSection />}
                    {section === 'tracking' && <TrackingSection />}
                    {section === 'gallery' && <Gallery />}
                </div>
            </div>
        </div>
    );
}
