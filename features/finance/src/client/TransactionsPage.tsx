import { Button, StickyHeader } from 'deveye-sdk-client';
import type { FinanceTransaction } from '../contracts/domain';

import Journal from './Journal';
import styles from './style.module.css';
import type { FinanceBase } from './shared';

interface TransactionsPageProps {
    base: FinanceBase;
    onBack: () => void;
    onNew: () => void;
    onEdit: (transaction: FinanceTransaction) => void;
}

/** Toutes les opérations de l'espace, tous comptes confondus. */
export function TransactionsPage({ base, onBack, onNew, onEdit }: TransactionsPageProps) {
    return (
        <div className={styles.page}>
            <StickyHeader>
                <header className={styles.pageHead}>
                    <Button variant='ghost' icon='arrow-left' onClick={onBack}>
                        Accueil
                    </Button>
                    <h2 className={styles.pageTitle}>Opérations</h2>
                    {base.canWrite && base.accounts.length > 0 && (
                        <Button icon='add' onClick={onNew}>
                            Opération
                        </Button>
                    )}
                </header>
            </StickyHeader>
            <Journal base={base} onEdit={onEdit} />
        </div>
    );
}

export default TransactionsPage;
