import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    Button,
    ConfirmDialog,
    humanizeError,
    SearchSelect,
    settingsStyles as shell,
    useActiveWorkspace,
    useWorkspaces,
    type ConfirmRequest
} from 'deveye-sdk-client';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';

import type { InvoicingDoc, InvoicingSettings } from '../contracts/domain';
import { api, refreshInvoicing } from './api';

/**
 * Faire passer un document dans un autre de ses espaces. Il y arrive toujours en
 * brouillon : un numéro appartient à la suite de l'espace qui l'a émis, et une
 * pièce émise posée ailleurs y ferait un numéro étranger. Copier vaut donc pour
 * tout document, déplacer pour un brouillon seulement.
 *
 * Le navigateur porte l'un à l'autre : la lecture s'exécute ici, l'écriture
 * là-bas, chacune sous les droits de l'appelant dans son espace.
 */

type Gesture = 'copy' | 'move';

/** Ce que le document laisse derrière lui, nommé avant de confirmer. */
function lossesOf(doc: InvoicingDoc, target: InvoicingSettings, here: InvoicingSettings): string[] {
    const lost: string[] = [];
    if (doc.status !== 'draft') {
        lost.push('Son numéro et sa date d’émission : il arrive en brouillon, à émettre là-bas.');
        lost.push(
            'Son lien en ligne, sur l’adresse ou le domaine d’ici, et la réponse du client : un nouveau lien naîtra à l’émission.'
        );
        if (doc.sentAt !== null) lost.push('La trace de son envoi par mail.');
        if (doc.kind === 'invoice' && doc.settledCents > 0) lost.push('Ses règlements enregistrés.');
        if (doc.kind === 'invoice') lost.push('Ses relances de retard et les notifications qui le concernent ici.');
    }
    if (doc.parentId !== null) {
        lost.push(
            doc.kind === 'credit'
                ? 'Son lien avec la facture qu’il corrige, qui reste ici.'
                : 'Son lien avec le devis d’origine et les acomptes à déduire, qui restent ici.'
        );
    }
    if (doc.dueOn !== null || doc.validUntil !== null) {
        lost.push('Ses échéances : elles repartiront des réglages de l’autre espace.');
    }
    if (target.currency !== here.currency) {
        lost.push(
            `La devise : l’autre espace facture en ${target.currency}, les montants y sont repris tels quels, sans conversion.`
        );
    }
    if (target.vatRegime === 'exempt' && doc.totals.vatCents > 0) {
        lost.push('La TVA : l’autre espace est en franchise, ses lignes y arrivent sans taux.');
    }
    return lost;
}

export default function DocumentElsewherePanel({ scope, gone }: SettingsPanelProps) {
    const id = scope.kind === 'record' ? Number(scope.recordId) : null;
    const active = useActiveWorkspace();
    const workspaces = useWorkspaces();
    const [doc, setDoc] = useState<InvoicingDoc | null>(null);
    const [here, setHere] = useState<InvoicingSettings | null>(null);
    const [choice, setChoice] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState<string | null>(null);
    const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

    const load = useCallback(async () => {
        if (id === null) return;
        try {
            const [opened, config] = await Promise.all([
                api.send('invoicing.doc', { id }),
                api.send('invoicing.config', {})
            ]);
            setDoc(opened.doc);
            setHere(config.settings);
        } catch (e) {
            setError(humanizeError(e, 'Ce document n’a pas pu être lu.'));
        }
    }, [id]);

    useEffect(() => {
        void load();
    }, [load]);

    // Seuls les espaces où Facturation est activée peuvent le recevoir ; le
    // droit d'y écrire, c'est le serveur de là-bas qui le juge.
    const targets = useMemo(
        () => workspaces.filter((w) => w.id !== active?.id && w.features.includes('invoicing')),
        [workspaces, active?.id]
    );

    if (doc === null || here === null) {
        return <p className={error ? shell.notice : shell.empty}>{error ?? 'Chargement…'}</p>;
    }

    const draft = doc.status === 'draft';
    const opened = doc;
    const settings = here;

    if (targets.length === 0) {
        return (
            <div className={shell.section}>
                <p className={shell.sectionHint}>
                    Aucun autre de vos espaces n’a Facturation. Activez-la dans un autre espace pour y copier ce
                    document.
                </p>
            </div>
        );
    }

    const run = async (gesture: Gesture, workspaceId: number, name: string) => {
        setConfirm(null);
        setBusy(true);
        setError(null);
        setDone(null);
        let imported = false;
        try {
            const { copy } = await api.send('invoicing.docExport', { id: opened.id });
            const res = await api.send('invoicing.docImport', { copy }, { workspaceId });
            imported = true;
            if (gesture === 'move') {
                await api.send('invoicing.docRemove', { id: opened.id });
                gone();
                refreshInvoicing();
                return;
            }
            setDone(
                res.clientCreated
                    ? `Un brouillon est né dans « ${name} », avec son client, qui n’y existait pas encore.`
                    : `Un brouillon est né dans « ${name} ».`
            );
        } catch (e) {
            setError(
                imported
                    ? `Le brouillon est arrivé dans « ${name} », mais n’a pas pu être retiré d’ici : supprimez-le vous-même depuis l’onglet Général.`
                    : humanizeError(e, `Le document n’a pas pu partir vers « ${name} ».`)
            );
        } finally {
            setBusy(false);
        }
    };

    const ask = async (gesture: Gesture) => {
        const target = targets.find((w) => String(w.id) === choice);
        if (!target) return;
        setBusy(true);
        setError(null);
        try {
            const config = await api.send('invoicing.config', {}, { workspaceId: target.id });
            const lost = lossesOf(opened, config.settings, settings);
            setConfirm({
                title: gesture === 'move' ? `Déplacer vers « ${target.name} » ?` : `Copier vers « ${target.name} » ?`,
                description: (
                    <>
                        <p>
                            {gesture === 'move'
                                ? 'Le brouillon quitte cet espace et part là-bas avec son client, son objet et ses lignes.'
                                : 'Un brouillon neuf naît là-bas avec le client, l’objet et les lignes de ce document, qui reste ici tel quel.'}{' '}
                            Le client est repris s’il y existe sous le même nom, créé sinon.
                        </p>
                        {lost.length > 0 && (
                            <>
                                <p>{gesture === 'move' ? 'Il perd en chemin :' : 'La copie n’emporte pas :'}</p>
                                <ul>
                                    {lost.map((line) => (
                                        <li key={line}>{line}</li>
                                    ))}
                                </ul>
                            </>
                        )}
                    </>
                ),
                confirmLabel: gesture === 'move' ? 'Déplacer' : 'Copier',
                tone: gesture === 'move' ? 'danger' : 'primary',
                onConfirm: () => void run(gesture, target.id, target.name)
            });
        } catch (e) {
            setError(humanizeError(e, `« ${target.name} » n’a pas pu être consulté.`));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className={shell.section}>
            <div className={shell.field}>
                <span className={shell.fieldLabel}>Vers</span>
                <SearchSelect
                    value={choice}
                    disabled={busy}
                    aria-label='Espace d’arrivée'
                    placeholder='Choisir un espace…'
                    options={targets.map((w) => ({ value: String(w.id), label: w.name }))}
                    onChange={setChoice}
                />
            </div>

            <div className={shell.field}>
                <div>
                    <Button
                        variant='secondary'
                        icon='copy'
                        disabled={busy || choice === ''}
                        onClick={() => void ask('copy')}
                    >
                        Copier…
                    </Button>
                </div>
                <span className={shell.fieldHint}>
                    Un brouillon neuf, indépendant de celui-ci, dans l’espace choisi.
                    {!draft && ' Ce document-ci reste ici, tel qu’il a été émis.'}
                </span>
            </div>

            <div className={shell.field}>
                <div>
                    <Button
                        variant='secondary'
                        icon='move-to-right'
                        disabled={busy || choice === '' || !draft}
                        onClick={() => void ask('move')}
                    >
                        Déplacer…
                    </Button>
                </div>
                <span className={shell.fieldHint}>
                    {draft
                        ? 'Le brouillon quitte cet espace pour de bon, et sa fiche se referme.'
                        : 'Un document émis ne se déplace pas : son numéro appartient à la suite de cet espace. Copiez-le, il arrivera en brouillon.'}
                </span>
            </div>

            {error && <p className={shell.notice}>{error}</p>}
            {done && <p className={shell.sectionHint}>{done}</p>}
            <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} busy={busy} />
        </div>
    );
}
