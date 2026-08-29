import { useEffect, useState } from 'react';
import { Button, Dialog, Switch } from 'deveye-sdk-client';

import type { DeviceShareTarget } from '../../contracts/commands';
import { api } from '../api';
import styles from './style.module.css';

interface WorkspaceShareDialogProps {
    open: boolean;
    /** L'appareil visé ; `null` referme le dialogue. */
    target: { id: string; name: string } | null;
    onClose: () => void;
    /** Appelé après un enregistrement réussi (le parent relit la flotte). */
    onSaved: () => void;
}

/**
 * Quels espaces ont accès à un appareil : un interrupteur par espace partagé.
 * L'espace d'appairage y figure activé et verrouillé : il porte l'unicité de
 * l'empreinte et le ré-enrôlement. Les espaces personnels ne sont pas proposés :
 * l'accueil personnel d'un administrateur voit déjà toute la flotte.
 */
export function WorkspaceShareDialog({ open, target, onClose, onSaved }: WorkspaceShareDialogProps) {
    const [rows, setRows] = useState<DeviceShareTarget[]>([]);
    const [originId, setOriginId] = useState<number | null>(null);
    const [selected, setSelected] = useState<Set<number>>(new Set());
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!open || !target) return;
        let cancelled = false;
        setLoading(true);
        setError(null);
        api.send('devices.workspaceList', { deviceId: target.id })
            .then((res) => {
                if (cancelled) return;
                setRows(res.workspaces);
                setOriginId(res.originWorkspaceId);
                setSelected(new Set(res.workspaces.filter((w) => w.shared).map((w) => w.id)));
            })
            .catch((e: unknown) => {
                if (!cancelled) setError(e instanceof Error ? e.message : 'Chargement impossible.');
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [open, target?.id]);

    const toggle = (id: number) => {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const save = async () => {
        if (!target) return;
        setSaving(true);
        setError(null);
        try {
            await api.send('devices.setWorkspaces', { deviceId: target.id, workspaceIds: [...selected] });
            onSaved();
            onClose();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Enregistrement impossible.');
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title={target ? `Espaces — ${target.name}` : 'Espaces'}
            description='Les espaces cochés voient cet appareil dans leur liste « Appareils ». Leurs membres le lisent ou le pilotent selon la permission « Appareils » de leur rôle.'
            width={520}
            onSubmit={() => void save()}
            footer={
                <>
                    <Button variant='secondary' onClick={onClose}>
                        Annuler
                    </Button>
                    <Button onClick={save} disabled={saving || loading}>
                        {saving ? 'Enregistrement…' : 'Enregistrer'}
                    </Button>
                </>
            }
        >
            {loading ? (
                <p className={styles.shareEmpty}>Chargement…</p>
            ) : rows.length === 0 ? (
                <p className={styles.shareEmpty}>Aucun espace partagé à proposer.</p>
            ) : (
                <div className={styles.shareList}>
                    {rows.map((w) => {
                        const isOrigin = w.id === originId;
                        return (
                            <Switch
                                key={w.id}
                                checked={isOrigin || selected.has(w.id)}
                                disabled={isOrigin}
                                onChange={() => toggle(w.id)}
                                label={w.name}
                                hint={isOrigin ? 'Espace d’appairage — accès permanent' : undefined}
                            />
                        );
                    })}
                </div>
            )}
            {error && <p className={styles.shareError}>{error}</p>}
        </Dialog>
    );
}
