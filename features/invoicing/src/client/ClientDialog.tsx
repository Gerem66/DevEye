import { useState } from 'react';
import {
    Button,
    Dialog,
    DialogCancelButton,
    humanizeError,
    invalidate,
    SegmentedControl,
    TextInput
} from 'deveye-sdk-client';

import type { ClientKind, InvoicingClientInput } from '../contracts/domain';
import { api } from './api';
import styles from './style.module.css';

/**
 * Le dialogue de création, et rien d'autre : ce qu'il demande vit ensuite dans
 * l'onglet Général du client. Il ne demande donc que le minimum pour qu'un
 * client existe, le reste se complète à la fiche.
 */

export interface ClientDialogProps {
    open: boolean;
    onClose(): void;
    onCreated(id: number): void;
}

const EMPTY: InvoicingClientInput = {
    kind: 'company',
    name: '',
    contactName: '',
    email: '',
    phone: '',
    address: '',
    postalCode: '',
    city: '',
    country: 'France',
    siret: '',
    vatNumber: '',
    note: '',
    paymentTermsDays: null,
    defaultVatBp: null
};

export default function ClientDialog({ open, onClose, onCreated }: ClientDialogProps) {
    const [draft, setDraft] = useState<InvoicingClientInput>(EMPTY);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const close = () => {
        setDraft(EMPTY);
        setError(null);
        onClose();
    };

    const submit = () => {
        if (busy || draft.name.trim().length === 0) return;
        setBusy(true);
        setError(null);
        void api
            .send('invoicing.clientSave', { id: null, client: draft, archived: false })
            .then((res) => {
                // Une popup d'ajout se ferme après un ajout réussi. Et on ravive
                // ce qui montre le carnet : attendre le retour du sujet live
                // ferait patienter l'auteur de l'écriture devant son propre ajout.
                invalidate('invoicing.clientList', 'invoicing.dashboard');
                setDraft(EMPTY);
                onCreated(res.client.id);
            })
            .catch((e) => setError(humanizeError(e, 'Ce client n’a pas pu être enregistré.')))
            .finally(() => setBusy(false));
    };

    return (
        <Dialog
            open={open}
            onClose={close}
            onSubmit={submit}
            title='Nouveau client'
            description='Son nom suffit pour commencer. L’adresse et le SIRET se complètent sur sa fiche, et paraîtront sur ses documents.'
            width={460}
            footer={
                <>
                    <DialogCancelButton>Annuler</DialogCancelButton>
                    <Button onClick={submit} disabled={busy || draft.name.trim().length === 0}>
                        Créer
                    </Button>
                </>
            }
        >
            <div className={styles.dialogFields}>
                <SegmentedControl
                    value={draft.kind}
                    options={[
                        { value: 'company' as ClientKind, label: 'Entreprise' },
                        { value: 'person' as ClientKind, label: 'Particulier' }
                    ]}
                    onChange={(kind) => setDraft((d) => ({ ...d, kind }))}
                    aria-label='Type de client'
                    fullWidth
                />

                <label className={styles.dialogField}>
                    <span className={styles.dialogLabel}>
                        {draft.kind === 'company' ? 'Dénomination' : 'Nom et prénom'}
                    </span>
                    <TextInput
                        data-autofocus
                        value={draft.name}
                        onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                    />
                </label>

                <label className={styles.dialogField}>
                    <span className={styles.dialogLabel}>Adresse e-mail</span>
                    <TextInput
                        type='email'
                        value={draft.email}
                        onChange={(e) => setDraft((d) => ({ ...d, email: e.target.value }))}
                    />
                    <span className={styles.dialogHint}>C’est à cette adresse que partiront ses documents.</span>
                </label>

                {error && <p className={styles.error}>{error}</p>}
            </div>
        </Dialog>
    );
}
