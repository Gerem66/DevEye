import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useActiveWorkspace, useLiveSegment, useResource } from 'deveye-sdk-client';

import ClientDialog from './ClientDialog';
import ClientSheet from './ClientSheet';
import ClientsPage from './ClientsPage';
import DocumentDialog from './DocumentDialog';
import DocumentSheet from './DocumentSheet';
import DocumentsPage from './DocumentsPage';
import Home from './Home';
import { api } from './api';
import styles from './style.module.css';

/**
 * La facturation de l'espace. Pas d'onglets : l'accueil porte les chiffres et,
 * juste dessous, les derniers documents et les derniers clients, avec de quoi en
 * créer et de quoi voir le reste. Aller droit au but plutôt que ranger.
 *
 * Aucun mot de passe demandé : tout vit à l'étage ouvert, pour que tout membre
 * d'un espace partagé lise les documents sans dépendre de la session de son
 * propriétaire.
 */

/**
 * `from` retient d'où une fiche a été ouverte : revenir à l'accueil depuis une
 * fiche atteinte par le journal ferait perdre les filtres qu'on venait de poser.
 */
type Origin = 'home' | 'documents' | 'clients';

type View =
    | { kind: 'home' }
    | { kind: 'documents' }
    | { kind: 'document'; id: number; from: Origin }
    | { kind: 'clients' }
    | { kind: 'client'; id: number; from: Origin };

/**
 * Ce que la présence déclare pour l'écran courant. **Un seul déclarant par
 * niveau** : c'est ici, et nulle part ailleurs. Le segment d'un client est son
 * identifiant nu, parce qu'un client est un élément de la feature et que c'est
 * ce que la téléportation de l'hôte écrit ; un document, qui n'en est pas un,
 * porte un préfixe pour ne pas se confondre avec lui.
 */
function segmentOf(view: View): string | null {
    if (view.kind === 'home') return null;
    if (view.kind === 'documents') return 'documents';
    if (view.kind === 'clients') return 'clients';
    if (view.kind === 'document') return `doc-${view.id}`;
    return String(view.id);
}

function viewOf(segment: string): View {
    if (segment === 'documents') return { kind: 'documents' };
    if (segment === 'clients') return { kind: 'clients' };
    const doc = /^doc-(\d+)$/.exec(segment);
    if (doc !== null) return { kind: 'document', id: Number(doc[1]), from: 'home' };
    if (/^\d+$/.test(segment)) return { kind: 'client', id: Number(segment), from: 'home' };
    return { kind: 'home' };
}

export default function Invoicing() {
    const workspaceId = useActiveWorkspace()?.id ?? null;
    const [view, setView] = useState<View>({ kind: 'home' });
    const [creatingDoc, setCreatingDoc] = useState(false);
    const [creatingClient, setCreatingClient] = useState(false);

    const liveTarget = useLiveSegment('l1', segmentOf(view));
    useEffect(() => {
        if (!liveTarget || liveTarget.value === null) return;
        setView(viewOf(liveTarget.value));
    }, [liveTarget]);

    /**
     * Le socle : la devise et le régime de TVA décident de ce que chaque écran
     * affiche, jusqu'au symbole de chaque montant. Les relire écran par écran
     * montrerait deux devises à la même seconde.
     */
    const load = useCallback(async () => api.send('invoicing.config', {}), [workspaceId]);
    const { data, error, loading } = useResource('invoicing.config', load, 'Chargement impossible.', [workspaceId]);

    if (loading && data === null) {
        return (
            <div className={styles.feature}>
                <p className={styles.placeholder}>Chargement…</p>
            </div>
        );
    }

    if (data === null) {
        return (
            <div className={styles.feature}>
                <p className={styles.error}>{error ?? 'Chargement impossible.'}</p>
            </div>
        );
    }

    const currency = data.settings.currency;
    const home = () => setView({ kind: 'home' });
    const back = (from: Origin) => () => setView({ kind: from });
    const LABELS: Record<Origin, string> = { home: 'Accueil', documents: 'Documents', clients: 'Clients' };

    return (
        <div className={styles.feature}>
            {/* Un fondu court : un glissement supposerait un ordre entre les écrans. */}
            <AnimatePresence mode='wait' initial={false}>
                <motion.div
                    key={segmentOf(view) ?? 'home'}
                    className={styles.panel}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    transition={{ duration: 0.16, ease: 'easeOut' }}
                >
                    {view.kind === 'home' && (
                        <Home
                            settings={data.settings}
                            onOpenDocuments={() => setView({ kind: 'documents' })}
                            onOpenClients={() => setView({ kind: 'clients' })}
                            onOpenDocument={(id) => setView({ kind: 'document', id, from: 'home' })}
                            onOpenClient={(id) => setView({ kind: 'client', id, from: 'home' })}
                            onNewDocument={() => setCreatingDoc(true)}
                            onNewClient={() => setCreatingClient(true)}
                        />
                    )}

                    {view.kind === 'documents' && (
                        <DocumentsPage
                            currency={currency}
                            onBack={home}
                            onOpen={(id) => setView({ kind: 'document', id, from: 'documents' })}
                            onNew={() => setCreatingDoc(true)}
                        />
                    )}

                    {view.kind === 'document' && (
                        <DocumentSheet
                            id={view.id}
                            usage={data.usage}
                            defaultVatBp={data.settings.defaultVatBp}
                            backLabel={LABELS[view.from]}
                            onBack={back(view.from)}
                            onOpen={(id) => setView({ kind: 'document', id, from: view.from })}
                        />
                    )}

                    {view.kind === 'clients' && (
                        <ClientsPage
                            currency={currency}
                            onBack={home}
                            onOpen={(id) => setView({ kind: 'client', id, from: 'clients' })}
                            onNew={() => setCreatingClient(true)}
                        />
                    )}

                    {view.kind === 'client' && (
                        <ClientSheet
                            id={view.id}
                            currency={currency}
                            backLabel={LABELS[view.from]}
                            onBack={back(view.from)}
                            onGone={back(view.from)}
                        />
                    )}
                </motion.div>
            </AnimatePresence>

            <DocumentDialog
                open={creatingDoc}
                onClose={() => setCreatingDoc(false)}
                onCreated={(id) => {
                    setCreatingDoc(false);
                    setView({ kind: 'document', id, from: view.kind === 'documents' ? 'documents' : 'home' });
                }}
            />

            <ClientDialog
                open={creatingClient}
                onClose={() => setCreatingClient(false)}
                onCreated={(id) => {
                    setCreatingClient(false);
                    setView({ kind: 'client', id, from: view.kind === 'clients' ? 'clients' : 'home' });
                }}
            />
        </div>
    );
}
