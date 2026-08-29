import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
    Button,
    FeatureSettingsButton,
    useActiveWorkspace,
    useLiveSegment,
    useResource,
    useWorkspacePermissions
} from 'deveye-sdk-client';
import type { FinanceTransaction } from '../contracts/domain';

import Accounts from './Accounts';
import Budgets from './Budgets';
import Dashboard from './Dashboard';
import Recurring from './Recurring';
import TransactionDialog from './TransactionDialog';
import Transactions from './Transactions';
import { api, refreshFinance } from './api';
import { todayIso } from './format';
import styles from './style.module.css';
import type { FinanceBase } from './shared';

/**
 * Les finances de l'espace : le grand livre. Aucun mot de passe demandé : tout
 * vit à l'étage ouvert, pour que tout membre d'un espace partagé lise les
 * comptes sans dépendre de la session du propriétaire. Cinq onglets ; les
 * catégories et les réglages sont des panneaux de la coquille de réglages.
 */

type TabId = 'dashboard' | 'transactions' | 'accounts' | 'budgets' | 'recurring';

const TABS: { id: TabId; label: string; icon: string }[] = [
    { id: 'dashboard', label: 'Tableau de bord', icon: 'activity' },
    { id: 'transactions', label: 'Opérations', icon: 'list' },
    { id: 'accounts', label: 'Comptes', icon: 'finance' },
    { id: 'budgets', label: 'Budgets', icon: 'square-check' },
    { id: 'recurring', label: 'Échéances', icon: 'clock' }
];

/** Ce que le dialogue d'opération reçoit: une ligne à modifier, ou une saisie neuve. */
export type TransactionDraft = { transaction: FinanceTransaction | null; accountId?: number };

export default function Finance() {
    const permissions = useWorkspacePermissions();
    const canWrite = permissions.canFeature('finance', 'write');
    const workspaceId = useActiveWorkspace()?.id ?? null;

    const [tab, setTab] = useState<TabId>('dashboard');
    const [dialog, setDialog] = useState<TransactionDraft | null>(null);

    // L'onglet ouvert est le niveau profond ; la racine `view:finance` vient de l'accueil.
    const liveTarget = useLiveSegment('l1', tab);
    useEffect(() => {
        if (!liveTarget || liveTarget.value === null) return;
        const wanted = TABS.find((entry) => entry.id === liveTarget.value);
        if (wanted) setTab(wanted.id);
    }, [liveTarget]);

    /**
     * Le socle en une seule requête groupée : séparées, un rendu intermédiaire
     * montrerait des lignes sans nom de compte.
     */
    const load = useCallback(async () => {
        const [config, accounts, categories] = await Promise.all([
            api.send('finance.config', {}),
            api.send('finance.accountList', { archived: true }),
            api.send('finance.categoryList', {})
        ]);
        return { config: config.config, accounts: accounts.accounts, categories: categories.categories };
    }, [workspaceId]);

    const {
        data,
        error,
        loading,
        reload: reloadBase
    } = useResource('finance.accountList', load, 'Chargement impossible.', [workspaceId]);

    if (loading && !data) {
        return (
            <div className={styles.feature}>
                <p className={styles.placeholder}>Chargement…</p>
            </div>
        );
    }

    if (!data) {
        return (
            <div className={styles.feature}>
                <p className={styles.error}>{error ?? 'Chargement impossible.'}</p>
            </div>
        );
    }

    const base: FinanceBase = { ...data, canWrite, reloadBase };
    const hasAccounts = data.accounts.length > 0;

    return (
        <div className={styles.feature}>
            <header className={styles.toolbar}>
                <nav className={styles.tabs} role='tablist'>
                    {TABS.map((entry) => (
                        <button
                            key={entry.id}
                            type='button'
                            role='tab'
                            aria-selected={entry.id === tab}
                            className={entry.id === tab ? styles.tabActive : styles.tab}
                            onClick={() => setTab(entry.id)}
                        >
                            <span className={`icon icon-${entry.icon}`} />
                            <span className={styles.tabLabel}>{entry.label}</span>
                        </button>
                    ))}
                </nav>

                <div className={styles.toolbarActions}>
                    {canWrite && hasAccounts && (
                        <Button icon='plus' onClick={() => setDialog({ transaction: null })}>
                            Opération
                        </Button>
                    )}
                    <FeatureSettingsButton scope={{ kind: 'feature', feature: 'finance' }} />
                </div>
            </header>

            {error && <p className={styles.error}>{error}</p>}

            {/* Un fondu court : un glissement supposerait un ordre entre les onglets. */}
            <AnimatePresence mode='wait' initial={false}>
                <motion.div
                    key={tab}
                    className={styles.panel}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    transition={{ duration: 0.16, ease: 'easeOut' }}
                >
                    {tab === 'dashboard' && (
                        <Dashboard
                            base={base}
                            onOpenTab={(next) => setTab(next as TabId)}
                            onNewTransaction={() => setDialog({ transaction: null })}
                        />
                    )}
                    {tab === 'transactions' && (
                        <Transactions base={base} onEdit={(transaction) => setDialog({ transaction })} />
                    )}
                    {tab === 'accounts' && <Accounts base={base} />}
                    {tab === 'budgets' && <Budgets base={base} />}
                    {tab === 'recurring' && <Recurring base={base} />}
                </motion.div>
            </AnimatePresence>

            <TransactionDialog
                base={base}
                open={dialog !== null}
                transaction={dialog?.transaction ?? null}
                defaultAccountId={dialog?.accountId}
                defaultDate={todayIso()}
                onClose={() => setDialog(null)}
                onSaved={() => {
                    setDialog(null);
                    refreshFinance();
                }}
            />
        </div>
    );
}
