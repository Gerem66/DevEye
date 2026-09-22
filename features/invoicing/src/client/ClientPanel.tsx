import { useCallback, useEffect, useState } from 'react';
import {
    Button,
    ConfirmDialog,
    humanizeError,
    invalidate,
    NumberInput,
    ReadOnlyNotice,
    SaveButton,
    SegmentedControl,
    settingsStyles as shell,
    Switch,
    TextInput,
    type ConfirmRequest
} from 'deveye-sdk-client';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';

import type { ClientKind, InvoicingClient, InvoicingClientInput } from '../contracts/domain';
import { api } from './api';
import styles from './style.module.css';

/**
 * L'onglet Général d'un client : ce que le dialogue de création demandait, et
 * tout ce qui le complète. La suppression est au bas de ce panneau, derrière une
 * confirmation qui dit ce qu'elle emporte.
 */

const FIELDS: { key: keyof InvoicingClientInput & string; label: string; hint?: string; wide?: boolean }[] = [
    { key: 'name', label: 'Dénomination ou nom', wide: true },
    { key: 'contactName', label: 'Personne à contacter' },
    { key: 'email', label: 'Adresse e-mail' },
    { key: 'phone', label: 'Téléphone' },
    { key: 'address', label: 'Adresse', wide: true },
    { key: 'postalCode', label: 'Code postal' },
    { key: 'city', label: 'Ville' },
    { key: 'country', label: 'Pays' },
    { key: 'siret', label: 'SIRET' },
    {
        key: 'vatNumber',
        label: 'Numéro de TVA intracommunautaire',
        hint: 'Nécessaire pour une opération intracommunautaire : il figure alors sur la facture.'
    }
];

export default function ClientPanel({ scope, canWrite, gone }: SettingsPanelProps) {
    const itemId = scope.kind === 'item' ? Number(scope.itemId) : null;
    const [draft, setDraft] = useState<InvoicingClient | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

    const load = useCallback(async () => {
        if (itemId === null) return;
        try {
            // Pas de commande « lire un client » : la liste est bornée et déjà
            // la seule lecture du carnet. Une commande de plus pour une ligne
            // n'apporterait rien.
            const res = await api.send('invoicing.clientList', { archived: true });
            const found = res.clients.find((client) => client.id === itemId) ?? null;
            if (found === null) setError('Ce client n’existe plus.');
            setDraft(found);
        } catch (e) {
            setError(humanizeError(e, 'Ce client n’a pas pu être lu.'));
        }
    }, [itemId]);

    useEffect(() => {
        void load();
    }, [load]);

    if (draft === null) {
        return <p className={error ? shell.notice : shell.empty}>{error ?? 'Chargement…'}</p>;
    }

    const set = (change: Partial<InvoicingClient>) => setDraft((d) => (d ? { ...d, ...change } : d));

    const submit = async () => {
        if (busy || itemId === null) return;
        setBusy(true);
        setError(null);
        try {
            const { id: _id, archived, usage: _usage, ...client } = draft;
            await api.send('invoicing.clientSave', { id: itemId, client, archived });
            invalidate('invoicing.clientList', 'invoicing.docList', 'invoicing.doc');
        } catch (e) {
            setError(humanizeError(e, 'Enregistrement impossible.'));
            throw e;
        } finally {
            setBusy(false);
        }
    };

    const remove = () => {
        if (itemId === null) return;
        setConfirm({
            title: `Retirer ${draft.name} ?`,
            description:
                draft.usage.documents > 0
                    ? `${draft.usage.documents} document${draft.usage.documents > 1 ? 's portent' : ' porte'} ce client : il ne peut pas être retiré. Mettez-le de côté pour qu’il sorte des sélecteurs sans rien perdre.`
                    : 'Ce client n’a aucun document. Son retrait est définitif.',
            confirmLabel: 'Retirer',
            tone: 'danger',
            onConfirm: () => {
                void (async () => {
                    try {
                        await api.send('invoicing.clientRemove', { id: itemId });
                        // `gone()` d'abord : ravivé avant de partir, l'écran
                        // irait chercher un client disparu.
                        gone();
                        invalidate('invoicing.clientList');
                    } catch (e) {
                        setError(humanizeError(e, 'Ce client n’a pas pu être retiré.'));
                    } finally {
                        setConfirm(null);
                    }
                })();
            }
        });
    };

    return (
        <div className={shell.section}>
            <SegmentedControl
                value={draft.kind}
                options={[
                    { value: 'company' as ClientKind, label: 'Entreprise' },
                    { value: 'person' as ClientKind, label: 'Particulier' }
                ]}
                disabled={!canWrite}
                onChange={(kind) => set({ kind })}
                aria-label='Type de client'
            />

            <div className={styles.fieldGrid}>
                {FIELDS.map((field) => (
                    <label key={field.key} className={`${shell.field} ${field.wide ? styles.fieldWide : ''}`}>
                        <span className={shell.fieldLabel}>{field.label}</span>
                        <TextInput
                            value={String(draft[field.key] ?? '')}
                            disabled={!canWrite}
                            onChange={(e) => set({ [field.key]: e.target.value })}
                        />
                        {field.hint && <span className={shell.fieldHint}>{field.hint}</span>}
                    </label>
                ))}
            </div>

            <label className={shell.field}>
                <span className={shell.fieldLabel}>Note interne</span>
                <textarea
                    className={styles.textarea}
                    rows={2}
                    value={draft.note}
                    disabled={!canWrite}
                    onChange={(e) => set({ note: e.target.value })}
                />
                <span className={shell.fieldHint}>Pour vous seul : elle ne paraît sur aucun document.</span>
            </label>

            <label className={shell.field} htmlFor='invoicing-client-terms'>
                <span className={shell.fieldLabel}>Délai de règlement propre, en jours</span>
                <NumberInput
                    id='invoicing-client-terms'
                    value={draft.paymentTermsDays}
                    min={0}
                    max={365}
                    disabled={!canWrite}
                    onChange={(value) => set({ paymentTermsDays: value })}
                />
                <span className={shell.fieldHint}>Vide : celui de l’espace.</span>
            </label>

            <Switch
                checked={draft.archived}
                disabled={!canWrite}
                onChange={(archived) => set({ archived })}
                label='Mettre ce client de côté'
                hint='Il sort des sélecteurs sans rien perdre, et ses documents restent intacts.'
            />

            {canWrite ? (
                <>
                    <SaveButton onSave={submit} disabled={busy} />
                    <div className={shell.sectionActions}>
                        <Button variant='danger' onClick={remove} disabled={busy}>
                            Retirer ce client
                        </Button>
                    </div>
                </>
            ) : (
                <ReadOnlyNotice>
                    Votre rôle ne permet pas de modifier ce client : cela relève de l’écriture sur Facturation.
                </ReadOnlyNotice>
            )}

            {error && <p className={shell.notice}>{error}</p>}
            <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} busy={busy} />
        </div>
    );
}
