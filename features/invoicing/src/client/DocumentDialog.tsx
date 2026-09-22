import { useCallback, useState } from 'react';
import {
    Button,
    Dialog,
    DialogCancelButton,
    humanizeError,
    SegmentedControl,
    TextInput,
    useResource
} from 'deveye-sdk-client';

import type { DocumentKind } from '../contracts/domain';
import ClientPicker from './ClientPicker';
import { api } from './api';
import styles from './style.module.css';

/**
 * Le dialogue de création, et rien d'autre. Il demande le minimum pour qu'un
 * document existe : le reste se remplit sur sa fiche, où on le voit prendre
 * forme.
 */
export interface DocumentDialogProps {
    open: boolean;
    onClose(): void;
    onCreated(id: number): void;
}

export default function DocumentDialog({ open, onClose, onCreated }: DocumentDialogProps) {
    // Le carnet, chargé par le dialogue lui-même : un dialogue autonome ne
    // dépend pas de ce que l'écran d'en dessous avait sous la main.
    const loadClients = useCallback(
        async () => (await api.send('invoicing.clientList', { archived: false })).clients,
        []
    );
    const { data: clients } = useResource('invoicing.clientList', loadClients, 'Clients illisibles.');
    const [kind, setKind] = useState<DocumentKind>('quote');
    const [clientId, setClientId] = useState<number | null>(null);
    const [subject, setSubject] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const close = () => {
        setSubject('');
        setError(null);
        onClose();
    };

    const submit = () => {
        if (busy) return;
        setBusy(true);
        setError(null);
        void api
            .send('invoicing.docSave', {
                id: null,
                kind,
                doc: {
                    clientId,
                    subject,
                    intro: '',
                    notes: '',
                    terms: '',
                    purchaseOrder: '',
                    performedOn: null,
                    dueOn: null,
                    validUntil: null
                }
            })
            .then((res) => {
                setSubject('');
                onCreated(res.doc.id);
            })
            .catch((e) => setError(humanizeError(e, 'Ce document n’a pas pu être créé.')))
            .finally(() => setBusy(false));
    };

    return (
        <Dialog
            open={open}
            onClose={close}
            onSubmit={submit}
            title='Nouveau document'
            description='Un devis propose, une facture demande le paiement. Le devis devient une facture en un clic quand votre client l’accepte.'
            width={460}
            footer={
                <>
                    <DialogCancelButton>Annuler</DialogCancelButton>
                    <Button onClick={submit} disabled={busy}>
                        Créer le brouillon
                    </Button>
                </>
            }
        >
            <div className={styles.dialogFields}>
                <SegmentedControl
                    value={kind}
                    options={[
                        { value: 'quote' as DocumentKind, label: 'Devis' },
                        { value: 'invoice' as DocumentKind, label: 'Facture' }
                    ]}
                    onChange={setKind}
                    aria-label='Type de document'
                    fullWidth
                />

                <div className={styles.dialogField}>
                    <span className={styles.dialogLabel}>Client</span>
                    <ClientPicker clients={clients ?? null} value={clientId} onChange={(id) => setClientId(id)} />
                    {clients !== null && clients.length > 0 && (
                        <span className={styles.dialogHint}>Il peut aussi se choisir plus tard, sur la fiche.</span>
                    )}
                </div>

                <label className={styles.dialogField}>
                    <span className={styles.dialogLabel}>Objet</span>
                    <TextInput
                        data-autofocus
                        value={subject}
                        placeholder='Refonte du site'
                        onChange={(e) => setSubject(e.target.value)}
                    />
                </label>

                {error && <p className={styles.error}>{error}</p>}
            </div>
        </Dialog>
    );
}
