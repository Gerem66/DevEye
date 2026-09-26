import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ErrorNote, useActiveWorkspace, useLiveSegment, useResource, useWorkspacePermissions } from 'deveye-sdk-client';
import type { FinanceTransaction } from '../contracts/domain';

import AccountDialog from './AccountDialog';
import AccountSheet from './AccountSheet';
import Home from './Home';
import RecurringPage from './RecurringPage';
import TransactionDialog from './TransactionDialog';
import TransactionsPage from './TransactionsPage';
import { api, refreshFinance } from './api';
import { todayIso } from './format';
import styles from './style.module.css';
import type { FinanceBase } from './shared';

/**
 * Les finances de l'espace. Pas d'onglets : l'accueil porte les chiffres, les
 * comptes, ce qui arrive et ce qui vient de passer, et « Voir tout » ouvre les
 * listes complètes. Aucun mot de passe demandé : tout vit à l'étage ouvert,
 * pour que tout membre lise les comptes sans la session de leur propriétaire.
 */

type View = { kind: 'home' } | { kind: 'transactions' } | { kind: 'recurring' } | { kind: 'account'; id: number };

/**
 * Ce que la présence déclare pour l'écran courant. Le segment d'un compte est
 * son identifiant nu : c'est ce que la téléportation de l'hôte écrit pour un
 * élément de la feature.
 */
function segmentOf(view: View): string | null {
    if (view.kind === 'home') return null;
    if (view.kind === 'account') return String(view.id);
    return view.kind;
}

function viewOf(segment: string): View {
    if (segment === 'transactions') return { kind: 'transactions' };
    if (segment === 'recurring') return { kind: 'recurring' };
    if (/^\d+$/.test(segment)) return { kind: 'account', id: Number(segment) };
    return { kind: 'home' };
}

/** Ce que le dialogue d'opération reçoit : une ligne à modifier, ou une saisie neuve. */
type TransactionDraft = { transaction: FinanceTransaction | null; accountId?: number };

export default function Finance() {
    const canWrite = useWorkspacePermissions().canFeature('finance', 'write');
    const workspaceId = useActiveWorkspace()?.id ?? null;

    const [view, setView] = useState<View>({ kind: 'home' });
    const [dialog, setDialog] = useState<TransactionDraft | null>(null);
    const [creatingAccount, setCreatingAccount] = useState(false);

    const liveTarget = useLiveSegment('l1', segmentOf(view));
    useEffect(() => {
        if (!liveTarget || liveTarget.value === null) return;
        setView(viewOf(liveTarget.value));
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
                <ErrorNote note={{ message: error ?? 'Chargement impossible.', code: null }} />
            </div>
        );
    }

    const base: FinanceBase = { ...data, canWrite, reloadBase };
    const home = () => setView({ kind: 'home' });
    const edit = (transaction: FinanceTransaction) => setDialog({ transaction });

    return (
        <div className={styles.feature}>
            {/* Un fondu court : un glissement supposerait un ordre entre les écrans. */}
            <AnimatePresence mode='wait' initial={false}>
                <motion.div
                    key={segmentOf(view) ?? 'home'}
                    className={styles.view}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    transition={{ duration: 0.16, ease: 'easeOut' }}
                >
                    {view.kind === 'home' && (
                        <Home
                            base={base}
                            onOpenAccount={(id) => setView({ kind: 'account', id })}
                            onOpenTransactions={() => setView({ kind: 'transactions' })}
                            onOpenRecurring={() => setView({ kind: 'recurring' })}
                            onNewAccount={() => setCreatingAccount(true)}
                            onNewTransaction={() => setDialog({ transaction: null })}
                            onEditTransaction={edit}
                        />
                    )}

                    {view.kind === 'transactions' && (
                        <TransactionsPage
                            base={base}
                            onBack={home}
                            onNew={() => setDialog({ transaction: null })}
                            onEdit={edit}
                        />
                    )}

                    {view.kind === 'recurring' && <RecurringPage base={base} onBack={home} />}

                    {view.kind === 'account' && (
                        <AccountSheet
                            base={base}
                            accountId={view.id}
                            onBack={home}
                            onGone={home}
                            onNewTransaction={(accountId) => setDialog({ transaction: null, accountId })}
                            onEdit={edit}
                        />
                    )}
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

            <AccountDialog
                open={creatingAccount}
                offerInvoicing={data.config.invoicing.available && data.config.invoicing.accountId === null}
                onClose={() => setCreatingAccount(false)}
                onCreated={() => {
                    setCreatingAccount(false);
                    reloadBase();
                    refreshFinance();
                }}
            />
        </div>
    );
}
