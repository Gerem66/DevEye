import { useEffect, useMemo, useState } from 'react';
import { humanizeError, SearchSelect, settingsStyles as shell, type SearchSelectOption } from 'deveye-sdk-client';
import type { UptimeDeployCandidate, UptimeDeployCandidateKind } from '../contracts/domain';

import { api } from './api';
import { DEPLOY_GROUPS, DEPLOY_ICONS, deployKey } from './format';
import styles from './style.module.css';

interface DeploySourcePickerProps {
    serviceId: number;
    /** Les clés choisies (`deploy:5`, `hook`). */
    value: readonly string[];
    onChange: (value: string[]) => void;
    disabled?: boolean;
}

const compareNames = new Intl.Collator('fr', { sensitivity: 'base', numeric: true }).compare;

/**
 * « Ce qui met ce site en ligne » : projets, cibles de Déploiements, dépôts Git
 * et l'adresse d'appel du service, rangés par catégorie, chacune affichée même
 * vide pour qu'on voie ce qui peut servir.
 */
export default function DeploySourcePicker({ serviceId, value, onChange, disabled }: DeploySourcePickerProps) {
    const [kinds, setKinds] = useState<UptimeDeployCandidateKind[]>([]);
    const [candidates, setCandidates] = useState<UptimeDeployCandidate[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        void api
            .send('uptime.deploySources', { id: serviceId })
            .then((res) => {
                setKinds(res.kinds);
                setCandidates(res.candidates);
            })
            .catch((e) => setError(humanizeError(e, 'Les sources n’ont pas pu être lues.')));
    }, [serviceId]);

    const options = useMemo(
        () =>
            [...(candidates ?? [])]
                .sort((a, b) => compareNames(a.name, b.name))
                .map((c): SearchSelectOption => ({
                    value: deployKey(c.kind, c.id),
                    label: c.name,
                    group: DEPLOY_GROUPS[c.kind],
                    prefix: <span className={`icon icon-${DEPLOY_ICONS[c.kind]} ${styles.sourceIcon}`} />,
                    detail: c.tag ?? c.detail ?? undefined,
                    disabled: !c.available
                })),
        [candidates]
    );
    const groups = useMemo(() => kinds.map((kind) => DEPLOY_GROUPS[kind]), [kinds]);
    // Ce qui cloche dans ce qui est choisi : une source disparue, hors des droits.
    const notes = (candidates ?? []).filter((c) => c.reason && value.includes(deployKey(c.kind, c.id)));

    return (
        <>
            <SearchSelect
                multiple
                value={value}
                options={options}
                groups={groups}
                onChange={onChange}
                disabled={disabled || candidates === null}
                aria-label='Ce qui met ce site en ligne'
                placeholder={candidates === null ? 'Chargement des sources…' : 'Choisir des sources…'}
                searchPlaceholder='Rechercher un projet, une cible, un dépôt…'
                emptyText='Aucune source ne correspond'
            />
            {error && <span className={shell.notice}>{error}</span>}
            {notes.map((c) => (
                <span key={deployKey(c.kind, c.id)} className={shell.fieldHint}>
                    {c.name} : {c.reason}
                </span>
            ))}
        </>
    );
}
