import { Component, type ErrorInfo, type ReactNode } from 'react';
import styles from './CrashScreen.module.css';

interface Props {
    children: ReactNode;
}

interface State {
    error: Error | null;
    componentStack: string | null;
}

/**
 * Ce qui reste à l'écran quand une vue lève.
 *
 * Sans frontière, React 19 **démonte la racine entière** dès qu'un rendu jette :
 * l'application disparaît d'un coup et il ne reste que le fond du `body`. Pas un
 * message, pas une trace à l'écran — et rien pour savoir, après coup, ce qui
 * était tombé. C'est exactement ce qui s'est produit deux fois dans l'organiseur
 * de l'accueil, et ce qui a rendu le diagnostic si long : le symptôme effaçait
 * sa propre cause.
 *
 * Cette frontière ne *répare* rien, et ce n'est pas son rôle : elle rend la
 * panne **lisible**. L'erreur et la pile de composants s'affichent, se copient
 * en un clic, et l'application se recharge d'un bouton. Un bogue qui laisse une
 * trace se corrige ; un bogue qui laisse un écran noir se raconte.
 *
 * Une classe, parce que `componentDidCatch` n'a pas d'équivalent en fonction —
 * c'est la seule de l'application, et elle le restera.
 */
export class CrashScreen extends Component<Props, State> {
    state: State = { error: null, componentStack: null };

    static getDerivedStateFromError(error: Error): Partial<State> {
        return { error };
    }

    componentDidCatch(error: Error, info: ErrorInfo): void {
        // La console garde la pile complète, seule exploitable au débogage ;
        // l'écran, lui, n'en montre que ce qui tient et se lit.
        console.error('[DevEye] Rendu interrompu', error, info.componentStack);
        this.setState({ componentStack: info.componentStack ?? null });
    }

    private copy = (): void => {
        const { error, componentStack } = this.state;
        const text = [error?.stack ?? String(error), '', componentStack ?? ''].join('\n');
        void navigator.clipboard?.writeText(text).catch(() => {
            /* `navigator.clipboard` n'existe qu'en contexte sécurisé */
        });
    };

    render(): ReactNode {
        const { error, componentStack } = this.state;
        if (!error) return this.props.children;

        return (
            <div className={styles.root} role='alert'>
                <div className={styles.card}>
                    <span className={`icon icon-error ${styles.icon}`} aria-hidden='true' />
                    <h1 className={styles.title}>DevEye s’est interrompu</h1>
                    <p className={styles.lead}>
                        Une vue a levé une erreur pendant son rendu. Rien n’est perdu côté serveur : recharger repart de
                        l’état enregistré.
                    </p>
                    <pre className={styles.trace}>
                        {error.message}
                        {componentStack}
                    </pre>
                    <div className={styles.actions}>
                        <button type='button' className={styles.ghost} onClick={this.copy}>
                            Copier le détail
                        </button>
                        <button type='button' className={styles.primary} onClick={() => window.location.reload()}>
                            Recharger
                        </button>
                    </div>
                </div>
            </div>
        );
    }
}

export default CrashScreen;
