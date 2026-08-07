import { useCallback, useEffect, useState } from 'react';
import type { ProjectLink, ProjectLinkKind } from 'deveye-types';
import { Button, SelectInput } from '@/Components';
import { ws, WsError } from '@/api/ws';
import { invalidate, useResourceVersion } from '@/stores/invalidation';
import { useWorkspacePermissions } from '@/stores/workspace';
import { humanizeError } from '../api';
import styles from '../style.module.css';

/** Une cible possible, quelle que soit la feature d'où elle vient. */
interface Target {
    id: string;
    label: string;
}

const KIND_META: Record<ProjectLinkKind, { label: string; icon: string; feature: 'uptime' | 'devices' | 'notes' }> = {
    uptime: { label: 'Service Uptime', icon: 'uptime', feature: 'uptime' },
    device: { label: 'Appareil', icon: 'server', feature: 'devices' },
    note: { label: 'Note', icon: 'notes', feature: 'notes' }
};

const KINDS: ProjectLinkKind[] = ['uptime', 'device', 'note'];

interface LinksProps {
    projectId: number;
    canWrite: boolean;
}

/**
 * Les liens du projet vers le reste de DevEye.
 *
 * Volontairement en repli : c'est une information de contexte, consultée quand
 * on cherche « qu'est-ce qui tourne autour de ce projet ? », pas à chaque
 * ouverture.
 *
 * **Chaque feature garde ses droits.** Un membre sans accès à Uptime voit le
 * lien mais ne peut pas en lire le nom — la commande de liste lui est refusée,
 * et on retombe alors sur l'identifiant brut plutôt que de faire disparaître le
 * lien. C'est la feature visée qui tranche, pas celle-ci.
 */
export function Links({ projectId, canWrite }: LinksProps) {
    const permissions = useWorkspacePermissions();
    const [links, setLinks] = useState<ProjectLink[]>([]);
    const [targets, setTargets] = useState<Partial<Record<ProjectLinkKind, Target[]>>>({});
    const [kind, setKind] = useState<ProjectLinkKind>('uptime');
    const [picked, setPicked] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [open, setOpen] = useState(false);

    const version = useResourceVersion('project.board');

    const load = useCallback(async () => {
        try {
            const res = await ws.send('project.linkList', { projectId });
            setLinks(res.links);
            setError(null);
        } catch (e) {
            setError(humanizeError(e, 'Impossible de charger les liens.'));
        }
    }, [projectId]);

    useEffect(() => {
        void load();
    }, [load, version]);

    /**
     * Charge les cibles possibles d'un type. Un refus de droit n'est pas une
     * erreur à afficher : il veut simplement dire « tu ne peux pas choisir
     * ici », et le sélecteur reste vide avec une explication.
     */
    const loadTargets = useCallback(
        async (k: ProjectLinkKind) => {
            if (!permissions.canFeature(KIND_META[k].feature)) {
                setTargets((t) => ({ ...t, [k]: [] }));
                return;
            }
            try {
                let list: Target[] = [];
                if (k === 'uptime') {
                    const r = await ws.send('uptime.list', {});
                    list = r.services.map((s) => ({ id: String(s.id), label: s.name || `Service #${s.id}` }));
                } else if (k === 'device') {
                    const r = await ws.send('device.list', {});
                    list = r.devices.map((d) => ({ id: d.id, label: d.name }));
                } else {
                    const r = await ws.send('note.list', {});
                    list = r.notes.map((n) => ({ id: String(n.id), label: n.title || `Note #${n.id}` }));
                }
                setTargets((t) => ({ ...t, [k]: list }));
            } catch (e) {
                if (e instanceof WsError && e.code === 'forbidden') {
                    setTargets((t) => ({ ...t, [k]: [] }));
                    return;
                }
                setError(humanizeError(e, 'Impossible de charger les cibles.'));
            }
        },
        [permissions]
    );

    useEffect(() => {
        if (!open || !canWrite) return;
        void loadTargets(kind);
        setPicked('');
    }, [open, canWrite, kind, loadTargets]);

    // Les noms des liens déjà posés : mêmes listes, chargées à l'ouverture.
    useEffect(() => {
        if (!open) return;
        for (const k of KINDS) {
            if (links.some((l) => l.kind === k) && targets[k] === undefined) void loadTargets(k);
        }
    }, [open, links, targets, loadTargets]);

    const labelOf = (link: ProjectLink) =>
        targets[link.kind]?.find((t) => t.id === link.targetId)?.label ?? link.targetId;

    const add = async () => {
        if (!picked) return;
        try {
            await ws.send('project.linkAdd', { projectId, kind, targetId: picked });
            setPicked('');
            invalidate('project.board');
        } catch (e) {
            setError(humanizeError(e, 'Le lien n’a pas pu être ajouté.'));
        }
    };

    const remove = async (linkId: number) => {
        try {
            await ws.send('project.linkRemove', { linkId });
            invalidate('project.board');
        } catch (e) {
            setError(humanizeError(e, 'Le retrait a échoué.'));
        }
    };

    const available = targets[kind];
    const free = (available ?? []).filter((t) => !links.some((l) => l.kind === kind && l.targetId === t.id));

    return (
        <details className={styles.links} open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
            <summary>
                Liens DevEye{links.length > 0 && <span className={styles.linkCount}>{links.length}</span>}
            </summary>

            {error && <p className={styles.error}>{error}</p>}

            {links.length > 0 && (
                <ul className={styles.linkList}>
                    {links.map((link) => (
                        <li key={link.id} className={styles.tag}>
                            <span className={`icon icon-${KIND_META[link.kind].icon}`} />
                            {labelOf(link)}
                            {canWrite && (
                                <button
                                    type='button'
                                    className={styles.tagRemove}
                                    aria-label={`Retirer le lien ${labelOf(link)}`}
                                    onClick={() => void remove(link.id)}
                                >
                                    <span className='icon icon-x' />
                                </button>
                            )}
                        </li>
                    ))}
                </ul>
            )}

            {links.length === 0 && (
                <p className={styles.hint}>Aucun lien. Rattachez un service, un appareil ou une note.</p>
            )}

            {canWrite && (
                <div className={styles.tagRow}>
                    <SelectInput value={kind} onChange={(e) => setKind(e.target.value as ProjectLinkKind)}>
                        {KINDS.map((k) => (
                            <option key={k} value={k}>
                                {KIND_META[k].label}
                            </option>
                        ))}
                    </SelectInput>
                    <SelectInput
                        value={picked}
                        onChange={(e) => setPicked(e.target.value)}
                        disabled={free.length === 0}
                    >
                        <option value=''>
                            {available === undefined
                                ? 'Chargement…'
                                : free.length === 0
                                  ? 'Rien à rattacher'
                                  : 'Choisir…'}
                        </option>
                        {free.map((t) => (
                            <option key={t.id} value={t.id}>
                                {t.label}
                            </option>
                        ))}
                    </SelectInput>
                    <Button variant='secondary' onClick={() => void add()} disabled={!picked}>
                        Rattacher
                    </Button>
                </div>
            )}

            {canWrite && available?.length === 0 && !permissions.canFeature(KIND_META[kind].feature) && (
                <span className={styles.hint}>
                    Votre rôle ne donne pas accès à « {KIND_META[kind].label} » dans cet espace.
                </span>
            )}
        </details>
    );
}

export default Links;
