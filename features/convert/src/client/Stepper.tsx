import styles from './style.module.css';

export interface StepperStep {
    id: string;
    label: string;
    /** On ne saute pas en avant : une étape s'ouvre quand ce qui la précède est choisi. */
    reachable: boolean;
}

interface StepperProps {
    steps: readonly StepperStep[];
    current: string;
    onGo: (id: string) => void;
}

/** Le fil d'étapes de l'assistant : où l'on est, et un retour en arrière d'un clic. */
export function Stepper({ steps, current, onGo }: StepperProps) {
    const currentIndex = steps.findIndex((s) => s.id === current);
    return (
        <nav aria-label='Étapes de la conversion'>
            <ol className={styles.stepper}>
                {steps.map((step, index) => {
                    const active = step.id === current;
                    return (
                        <li key={step.id} className={styles.step}>
                            <button
                                type='button'
                                className={`${styles.stepButton} ${active ? styles.stepActive : ''} ${
                                    index < currentIndex ? styles.stepDone : ''
                                }`}
                                aria-current={active ? 'step' : undefined}
                                disabled={!step.reachable}
                                onClick={() => onGo(step.id)}
                            >
                                <span className={styles.stepNumber}>{index + 1}</span>
                                <span className={styles.stepLabel}>{step.label}</span>
                            </button>
                        </li>
                    );
                })}
            </ol>
        </nav>
    );
}
