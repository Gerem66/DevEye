import { Component, type ErrorInfo, type ReactNode } from 'react';

import Button from '@/Components/Button';
import { noteRenderError } from '@/diagnostics/trace';
import { requestOpenReport } from '@/stores/reportRequest';

import styles from './style.module.css';

interface Props {
    /**
     * `page` : tout l'écran est tombé, seul le rechargement reste. `view` : le
     * contenu d'une fonctionnalité, le reste de l'app demeure utilisable.
     */
    variant: 'page' | 'view';
    /** Propose le signalement : faux là où le bouton de signalement n'est plus monté. */
    canReport?: boolean;
    children: ReactNode;
}

interface State {
    failed: boolean;
}

/**
 * Arrête une erreur de rendu avant qu'elle ne démonte tout l'arbre : sans
 * frontière, React laisse une page blanche. L'erreur rejoint la trace jointe
 * aux signalements.
 */
export default class ErrorBoundary extends Component<Props, State> {
    state: State = { failed: false };

    static getDerivedStateFromError(): State {
        return { failed: true };
    }

    componentDidCatch(error: unknown, info: ErrorInfo): void {
        noteRenderError(error, info.componentStack ?? null);
    }

    render(): ReactNode {
        if (!this.state.failed) return this.props.children;
        const page = this.props.variant === 'page';
        return (
            <div className={page ? styles.page : styles.view} role='alert'>
                <span className={`icon icon-bug ${styles.icon}`} aria-hidden='true' />
                <h2 className={styles.title}>Une erreur est survenue</h2>
                <p className={styles.text}>
                    {page
                        ? 'DevEye n’a pas pu afficher cette page. La recharger règle le plus souvent le problème.'
                        : 'Cette fonctionnalité n’a pas pu s’afficher. Le reste de DevEye fonctionne toujours.'}
                </p>
                <div className={styles.actions}>
                    {page ? (
                        <Button icon='refresh' onClick={() => window.location.reload()}>
                            Recharger la page
                        </Button>
                    ) : (
                        <Button icon='refresh' onClick={() => this.setState({ failed: false })}>
                            Réessayer
                        </Button>
                    )}
                    {this.props.canReport && (
                        <Button
                            variant='secondary'
                            icon='bug'
                            onClick={() => requestOpenReport('Une erreur d’affichage est survenue.')}
                        >
                            Signaler le problème
                        </Button>
                    )}
                </div>
            </div>
        );
    }
}
