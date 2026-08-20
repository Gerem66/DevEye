import { useEffect, useState } from 'react';
import { FEATURE_REGISTRY, WORKSPACE_CAPABILITIES } from 'deveye-types';
import type { FeatureAccess, WorkspaceCapability, WorkspaceFeatureGrant, WorkspaceRole } from 'deveye-types';

import Button from '@/Components/Button';
import Checkbox from '@/Components/Checkbox';
import { Dialog } from '@/Components/Dialog';
import SegmentedControl from '@/Components/SegmentedControl';
import TextInput from '@/Components/TextInput';
import Tabs from './Tabs';
import styles from './Workspace.module.css';

/**
 * Édition d'un rôle : son identité **et** ses droits, dans une seule popup.
 *
 * Un détour a existé : l'identité ici, les droits dans une matrice globale
 * rôles × droits sous un onglet Permissions. Retiré : la grille répondait à
 * « qui peut ceci ? » mais l'usage réel est « configurer CE rôle », et couper un
 * rôle en deux écrans obligeait à savoir lequel des deux détenait quoi. Un rôle
 * se règle entier, là où on l'a créé.
 *
 * Entier, mais en deux volets : tout à la suite, la popup s'étirait en colonne
 * (six droits d'administration puis une ligne par fonctionnalité). La barre
 * d'onglets sépare ce qui touche à l'espace de ce qui touche aux
 * fonctionnalités ; le nom et la couleur, communs aux deux, restent en tête.
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

/**
 * Trois niveaux, toujours les mêmes : des boutons collés plutôt qu'un menu
 * déroulant, qui cachait trois choix connus d'avance derrière un clic.
 */
const ACCESS_OPTIONS = [
    { value: 'none', label: 'Aucun', title: 'La fonctionnalité n’apparaît pas' },
    { value: 'read', label: 'Lecture', title: 'Consulter, sans rien modifier' },
    { value: 'write', label: 'Écriture', title: 'Lecture et écriture' }
] as const;

/** Les deux volets du formulaire. */
type RoleTab = 'space' | 'features';

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
    const [tab, setTab] = useState<RoleTab>('space');

    useEffect(() => {
        if (!open) return;
        setTab('space');
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

    const grantedCount = Object.values(features).filter((a) => a !== 'none').length;

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
            width={620}
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

            {/* Les pastilles disent, depuis l'autre volet, combien de droits
                sont déjà cochés ici : le volet non affiché n'est jamais une
                boîte noire. */}
            <div className={styles.dialogTabs}>
                <Tabs<RoleTab>
                    tabs={[
                        { id: 'space', label: 'Espace', icon: 'shield', badge: capabilities.length },
                        { id: 'features', label: 'Fonctionnalités', icon: 'list', badge: grantedCount }
                    ]}
                    active={tab}
                    onSelect={setTab}
                />
            </div>

            {tab === 'space' && (
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
            )}

            {/* Toutes listées, y compris les non accordées : « Aucun » est un
                choix explicite, pas une absence de ligne. Les exceptions par
                élément (masquer une base à un rôle, un service en lecture
                seule) se règlent sur l'élément lui-même, dans ses réglages. */}
            {tab === 'features' && (
                <div className={`${styles.card} ${styles.rowList}`}>
                    {FEATURE_REGISTRY.map((f) => (
                        <div key={f.id} className={styles.grantRow}>
                            <span className={styles.grantLabel}>
                                <span className={styles.grantTitle}>
                                    <span className={`icon icon-${f.icon}`} aria-hidden='true' />
                                    {f.label}
                                </span>
                                {/* Ce que le droit recouvre, du registre : la ligne
                                    « Déploiement » ne dit pas seule que `write`
                                    permet une mise en production. */}
                                <span className={styles.grantHint}>{f.description}</span>
                            </span>
                            <SegmentedControl
                                aria-label={`Accès à ${f.label}`}
                                value={features[f.id] ?? 'none'}
                                options={ACCESS_OPTIONS}
                                onChange={(v) => setFeatures((prev) => ({ ...prev, [f.id]: v }))}
                            />
                        </div>
                    ))}
                </div>
            )}
        </Dialog>
    );
}
