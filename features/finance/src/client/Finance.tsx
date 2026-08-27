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
 * Les finances de l'espace: le grand livre, pour un particulier comme pour
 * une PME.
 *
 * Feature de premier rang et non un onglet des Projets, pour la même raison que
 * Git, les bases de données et l'audience: les comptes appartiennent à
 * l'**espace**, pas à un projet. Un espace personnel tient les finances d'un
 * foyer, un espace partagé celles d'une structure, et c'est le même objet des
 * deux côtés: seul le mode entreprise (la TVA) s'ajoute par-dessus.
 *
 * **Aucun mot de passe n'est jamais demandé ici.** Tout vit à l'étage ouvert du
 * chiffrement, sous la clé de l'espace, parce que tout membre d'un espace
 * partagé doit pouvoir lire les comptes de la structure sans dépendre de la
 * session de son propriétaire.
 *
 * ## Cinq onglets, et ce qui décide de la répartition
 *
 * Ce qu'on **regarde** (Tableau de bord), ce qu'on **saisit** (Opérations), et
 * les trois choses qu'on **règle** puis qu'on oublie: les comptes, les
 * enveloppes, les échéances. Les catégories et les réglages ne sont pas des
 * onglets mais deux panneaux de la coquille de réglages commune (Général,
 * Catégories), derrière le bouton de l'en-tête: on y va deux fois par an, et
 * leur donner une place permanente dans la barre pousserait vers le bas ce
 * qu'on ouvre tous les jours.
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
    // L'espace vient du SDK, plus des props: c'est lui qui borne le socle.
    const workspaceId = useActiveWorkspace()?.id ?? null;

    const [tab, setTab] = useState<TabId>('dashboard');
    const [dialog, setDialog] = useState<TransactionDraft | null>(null);

    // Le niveau profond des finances : l'onglet ouvert. La racine `view:finance`
    // vient de l'accueil ; cette feature n'annonce que le sien.
    const liveTarget = useLiveSegment('l1', tab);
    useEffect(() => {
        if (!liveTarget || liveTarget.value === null) return;
        const wanted = TABS.find((entry) => entry.id === liveTarget.value);
        if (wanted) setTab(wanted.id);
    }, [liveTarget]);

    /**
     * Le socle, en une seule requête groupée.
     *
     * Les trois lectures partent ensemble et arrivent ensemble: séparées, un
     * rendu intermédiaire montrerait un journal dont les comptes ne sont pas
     * encore chargés, c'est-à-dire des lignes sans nom de compte.
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
            {/* L'en-tête commun à toutes les features : les onglets à gauche,
                les actions à droite, le bouton de réglages commun en dernier.
                Ses deux panneaux (Général, Catégories) ont remplacé l'engrenage
                maison et ses deux dialogues. */}
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

            {/*
                Un fondu court d'un onglet à l'autre, et rien de plus. Un
                glissement horizontal supposerait un ordre entre les onglets
                qui n'existe pas, et une durée plus longue se ferait sentir dès
                le troisième aller-retour de la journée.
            */}
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
