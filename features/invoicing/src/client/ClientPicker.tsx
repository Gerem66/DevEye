import { useState } from 'react';
import { Button, SearchSelect } from 'deveye-sdk-client';

import type { InvoicingClient } from '../contracts/domain';
import ClientDialog from './ClientDialog';
import styles from './style.module.css';

/**
 * Le choix du client d'un document : le sélecteur, et collé à lui le « + » qui
 * ouvre la popup d'ajout. Le client créé s'y retrouve choisi, et le carnet se
 * ravive de lui-même, la popup invalidant sa clé de ressource.
 */
export interface ClientPickerProps {
    /** `null` tant que le carnet n'est pas lu : on n'annonce pas un vide qu'on ignore. */
    clients: readonly InvoicingClient[] | null;
    value: number | null;
    disabled?: boolean;
    onChange(id: number | null): void;
}

export default function ClientPicker({ clients, value, disabled, onChange }: ClientPickerProps) {
    const [adding, setAdding] = useState(false);

    const empty = clients !== null && clients.length === 0;

    return (
        <>
            <div className={styles.pickerRow}>
                <SearchSelect
                    className={styles.pickerSelect}
                    value={value === null ? '' : String(value)}
                    options={(clients ?? []).map((client) => ({
                        value: String(client.id),
                        label: client.name,
                        detail: [client.postalCode, client.city].filter((part) => part.length > 0).join(' ')
                    }))}
                    aria-label='Client du document'
                    placeholder='Choisir un client'
                    emptyText='Aucun client ne correspond'
                    disabled={disabled}
                    onChange={(next) => onChange(next === '' ? null : Number(next))}
                />
                <Button
                    variant='ghost'
                    icon='add'
                    aria-label='Ajouter un client'
                    title='Ajouter un client : il sera choisi ici une fois créé'
                    disabled={disabled}
                    onClick={() => setAdding(true)}
                />
            </div>

            {empty && (
                <span className={styles.dialogHint}>
                    Votre carnet est vide : ce bouton ajoute votre premier client.
                </span>
            )}

            <ClientDialog
                open={adding}
                onClose={() => setAdding(false)}
                onCreated={(id) => {
                    setAdding(false);
                    onChange(id);
                }}
            />
        </>
    );
}
