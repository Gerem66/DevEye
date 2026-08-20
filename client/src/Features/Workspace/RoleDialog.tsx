import { useEffect, useState } from 'react';
import { FEATURE_REGISTRY, WORKSPACE_CAPABILITIES } from 'deveye-types';
import type { FeatureAccess, WorkspaceCapability, WorkspaceFeatureGrant, WorkspaceRole } from 'deveye-types';

import Button from '@/Components/Button';
import Checkbox from '@/Components/Checkbox';
import { Dialog } from '@/Components/Dialog';
import SelectInput from '@/Components/SelectInput';
import TextInput from '@/Components/TextInput';
import styles from './Workspace.module.css';

/**
 * Édition d'un rôle : son identité **et** ses droits, dans une seule popup.
 *
 * Un détour a existé — l'identité ici, les droits dans une matrice globale
 * rôles × droits sous un onglet Permissions. Retiré : la grille répondait à
 * « qui peut ceci ? » mais l'usage réel est « configurer CE rôle », et couper un
 * rôle en deux écrans obligeait à savoir lequel des deux détenait quoi. Un rôle
 * se règle entier, là où on l'a créé.
 *
 * Les intitulés des features viennent du **registre** (`FEATURE_REGISTRY`),
 * plus d'une table locale : c'est ce qui garantit qu'une fonctionnalité ajoutée
 * apparaît ici sans qu'on y pense.
 */

/** Intitulés en clair : l'enum technique ne se montre pas à l'utilisateur. */
const CAPABILITY_LABELS: Record<WorkspaceCapability, string> = {
    'workspace.manage': 'Renommer et supprimer l’espace',
    'workspace.members': 'Inviter et exclure des membres',
    'workspace.roles': 'Gérer les rôles et ce que chacun voit',
    'workspace.appearance': 'Modifier l’apparence',
    'workspace.layout': 'Modifier la disposition de l’accueil',
    'workspace.notifications': 'Gérer les canaux d’alerte'
};

export interface RoleDraft {
    name: string;
    color: string;
    capabilities: WorkspaceCapability[];
    features: WorkspaceFeatureGrant[];
}

export interface RoleDialogProps {
    open: boolean;
    /** Rôle édité, ou `null` pour une création. */
    role: WorkspaceRole | null;
    busy: boolean;
    onClose: () => void;
    onSubmit: (draft: RoleDraft) => void;
}

export default function RoleDialog({ open, role, busy, onClose, onSubmit }: RoleDialogProps) {
    const [name, setName] = useState('');
    const [color, setColor] = useState('#22d3ee');
    const [capabilities, setCapabilities] = useState<WorkspaceCapability[]>([]);
    const [features, setFeatures] = useState<Record<string, FeatureAccess | 'none'>>({});

    useEffect(() => {
        if (!open) return;
        setName(role?.name ?? '');
        setColor(role?.color ?? '#22d3ee');
        setCapabilities(role?.capabilities ?? []);
        setFeatures(
            Object.fromEntries(
                FEATURE_REGISTRY.map((f) => [f.id, role?.features.find((g) => g.feature === f.id)?.access ?? 'none'])
            )
        );
    }, [open, role]);

    const toggle = (c: WorkspaceCapability): void =>
        setCapabilities((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));

    const submit = (): void => {
        if (!name.trim()) return;
        onSubmit({
            name: name.trim(),
            color,
            capabilities,
            features: FEATURE_REGISTRY.flatMap<WorkspaceFeatureGrant>((f) => {
                const a = features[f.id];
                return a === 'read' || a === 'write' ? [{ feature: f.id, access: a }] : [];
            })
        });
    };

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title={role ? `Modifier « ${role.name} »` : 'Nouveau rôle'}
            width={520}
            onSubmit={submit}
            footer={
                <>
                    <Button variant='secondary' onClick={onClose} disabled={busy}>
                        Annuler
                    </Button>
                    <Button onClick={submit} disabled={busy || !name.trim()}>
                        {busy ? 'Enregistrement…' : role ? 'Enregistrer' : 'Créer'}
                    </Button>
                </>
            }
        >
            <div className={styles.nameRow}>
                <TextInput
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={64}
                    placeholder='Nom du rôle'
                    aria-label='Nom du rôle'
                />
                <input
                    type='color'
                    className={styles.colorInput}
                    value={color}
                    onChange={(e) => setColor(e.target.value)}
                    aria-label='Couleur du rôle'
                />
            </div>

            <span className={`${styles.sectionLabel} ${styles.formSection}`}>Administration de l’espace</span>
            <div className={`${styles.card} ${styles.rowList}`}>
                {WORKSPACE_CAPABILITIES.map((c) => {
                    const on = capabilities.includes(c);
                    return (
                        <Checkbox key={c} className={styles.checkRow} checked={on} onChange={() => toggle(c)}>
                            {CAPABILITY_LABELS[c]}
                        </Checkbox>
                    );
                })}
            </div>

            <span className={`${styles.sectionLabel} ${styles.formSection}`}>Fonctionnalités</span>
            {/* Toutes listées, y compris les non accordées — « Aucun accès » est
                un choix explicite, pas une absence de ligne. Les exceptions par
                élément (masquer une base à un rôle, un service en lecture
                seule) se règlent sur l'élément lui-même, dans ses réglages. */}
            <div className={`${styles.card} ${styles.rowList}`}>
                {FEATURE_REGISTRY.map((f) => (
                    <div key={f.id} className={styles.grantRow}>
                        <span className={styles.grantLabel}>
                            <span className={`icon icon-${f.icon}`} aria-hidden='true' /> {f.label}
                        </span>
                        <SelectInput
                            className={styles.grantSelect}
                            value={features[f.id] ?? 'none'}
                            aria-label={`Accès à ${f.label}`}
                            onChange={(e) =>
                                setFeatures((prev) => ({ ...prev, [f.id]: e.target.value as FeatureAccess | 'none' }))
                            }
                        >
                            <option value='none'>Aucun accès</option>
                            <option value='read'>Lecture</option>
                            <option value='write'>Lecture et écriture</option>
                        </SelectInput>
                    </div>
                ))}
            </div>
        </Dialog>
    );
}
