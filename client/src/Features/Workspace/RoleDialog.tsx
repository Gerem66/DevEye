import { useEffect, useState } from 'react';
import { WORKSPACE_CAPABILITIES, WORKSPACE_FEATURE_IDS } from 'deveye-types';
import type { FeatureAccess, WorkspaceCapability, WorkspaceFeatureGrant, WorkspaceRole } from 'deveye-types';

import Button from '@/Components/Button';
import Checkbox from '@/Components/Checkbox';
import { Dialog } from '@/Components/Dialog';
import SelectInput from '@/Components/SelectInput';
import TextInput from '@/Components/TextInput';
import styles from './Workspace.module.css';

/** Intitulés en clair : l'enum technique ne se montre pas à l'utilisateur. */
const CAPABILITY_LABELS: Record<WorkspaceCapability, string> = {
    'workspace.manage': 'Renommer et supprimer l’espace',
    'workspace.members': 'Inviter et exclure des membres',
    'workspace.roles': 'Gérer les rôles',
    'workspace.appearance': 'Modifier l’apparence',
    'workspace.layout': 'Modifier la disposition de l’accueil'
};

const FEATURE_LABELS: Record<(typeof WORKSPACE_FEATURE_IDS)[number], string> = {
    devices: 'Appareils',
    sentinel: 'Sentinelle',
    weather: 'Météo',
    password: 'Mots de passe',
    notes: 'Notes',
    cloudsync: 'CloudSync',
    uptime: 'Uptime',
    mail: 'Mail',
    projects: 'Projets',
    git: 'Git',
    deploy: 'Déploiement',
    database: 'Bases de données',
    audience: 'Audience',
    osint: 'OSINT'
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

/**
 * Édition d'un rôle : son nom, sa couleur, ses capacités et le niveau accordé
 * sur chaque feature.
 *
 * Les features sont toutes listées, y compris celles qui ne sont pas accordées —
 * « Aucun accès » est un choix explicite, pas une absence de ligne. C'est ce qui
 * rend le formulaire lisible d'un coup d'œil.
 */
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
                WORKSPACE_FEATURE_IDS.map((f) => [f, role?.features.find((g) => g.feature === f)?.access ?? 'none'])
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
            features: WORKSPACE_FEATURE_IDS.flatMap<WorkspaceFeatureGrant>((f) => {
                const a = features[f];
                return a === 'read' || a === 'write' ? [{ feature: f, access: a }] : [];
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
            <div className={`${styles.card} ${styles.rowList}`}>
                {WORKSPACE_FEATURE_IDS.map((f) => (
                    <div key={f} className={styles.grantRow}>
                        <span className={styles.grantLabel}>{FEATURE_LABELS[f]}</span>
                        <SelectInput
                            className={styles.grantSelect}
                            value={features[f] ?? 'none'}
                            onChange={(e) => setFeatures((prev) => ({ ...prev, [f]: e.target.value as FeatureAccess }))}
                            aria-label={`Accès à ${FEATURE_LABELS[f]}`}
                        >
                            <option value='none'>Aucun accès</option>
                            <option value='read'>Lecture</option>
                            <option value='write'>Écriture</option>
                        </SelectInput>
                    </div>
                ))}
            </div>
        </Dialog>
    );
}
