import { locate, useColorSchemeState } from '@/stores/colorScheme';
import styles from './style.module.css';

const clock = (ms: number) => new Date(ms).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

/** Ce que le choix du thème donne ici, en une ligne. */
export function SchemeHint() {
    const { mode, scheme, located, locating, today } = useColorSchemeState();
    if (mode === 'system') {
        return <>Suit le réglage de cet appareil, {scheme === 'light' ? 'clair' : 'sombre'} en ce moment</>;
    }
    if (mode !== 'auto' || !today) return <>Propre à cet appareil, dans tous vos espaces</>;
    if (locating) return <>Recherche de votre position…</>;
    const span =
        'polar' in today
            ? today.polar === 'day'
                ? 'Soleil de minuit : clair toute la journée'
                : 'Nuit polaire : sombre toute la journée'
            : `Clair de ${clock(today.rise)} à ${clock(today.set)}`;
    if (located) return <>{span}, d&apos;après votre position</>;
    return (
        <>
            {span} environ, d&apos;après le fuseau horaire.{' '}
            <button type='button' className={styles.hintLink} onClick={locate}>
                Utiliser ma position
            </button>
        </>
    );
}
