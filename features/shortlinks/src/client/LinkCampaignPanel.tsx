import {
    humanizeError,
    invalidate,
    ReadOnlyNotice,
    SaveButton,
    settingsStyles as shell,
    TextInput
} from 'deveye-sdk-client';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';
import { useEffect, useState } from 'react';

import { SHORTLINK_UTM_MAX, type Shortlink, type ShortlinkUtm } from '../contracts/domain';
import { api } from './api';
import { hasUtm, UTM_KEYS, UTM_PARAMS, withUtm } from './format';
import styles from './style.module.css';

const FIELDS: Readonly<Record<keyof ShortlinkUtm, { label: string; hint: string; placeholder: string }>> = {
    source: { label: 'Source', hint: 'D’où vient le visiteur.', placeholder: 'newsletter' },
    medium: { label: 'Support', hint: 'Le genre de canal.', placeholder: 'email' },
    campaign: { label: 'Campagne', hint: 'Le nom de l’opération.', placeholder: 'soldes-ete' },
    term: { label: 'Mot-clé', hint: 'Pour une annonce payante, le mot acheté.', placeholder: 'chaussures' },
    content: {
        label: 'Contenu',
        hint: 'Pour distinguer deux liens d’une même campagne.',
        placeholder: 'bouton-haut'
    }
};

const trimmed = (utm: ShortlinkUtm): ShortlinkUtm =>
    Object.fromEntries(UTM_KEYS.map((key) => [key, utm[key].trim()])) as ShortlinkUtm;

/**
 * Les paramètres de campagne que le lien ajoute à sa destination. Les outils de
 * mesure du site visé les lisent pour dire d'où viennent ses visiteurs.
 */
export default function LinkCampaignPanel({ scope, canWrite }: SettingsPanelProps) {
    const linkId = scope.kind === 'item' ? Number(scope.itemId) : null;
    const [link, setLink] = useState<Shortlink | null>(null);
    const [utm, setUtm] = useState<ShortlinkUtm | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (linkId === null) return;
        let live = true;
        api.send('shortlinks.get', { id: linkId })
            .then((res) => {
                if (!live) return;
                setLink(res.link);
                setUtm(res.link.utm);
            })
            .catch((failure: unknown) => {
                if (live) setError(humanizeError(failure, 'Le lien n’a pas pu être lu.'));
            });
        return () => {
            live = false;
        };
    }, [linkId]);

    if (link === null || utm === null) {
        return <p className={error ? shell.notice : shell.empty}>{error ?? 'Chargement…'}</p>;
    }

    if (link.foreign) {
        return (
            <p className={shell.sectionHint}>
                Ce lien vient d’un autre espace : ses paramètres de campagne se règlent depuis là-bas.
            </p>
        );
    }

    const editable = canWrite && !busy;
    const clean = trimmed(utm);
    const unchanged = UTM_KEYS.every((key) => clean[key] === link.utm[key]);

    const save = async () => {
        setBusy(true);
        setError(null);
        try {
            const res = await api.send('shortlinks.updateCampaign', { id: link.id, utm: clean });
            setLink(res.link);
            setUtm(res.link.utm);
            invalidate('shortlinks.list', 'shortlinks.get');
        } catch (failure) {
            setError(humanizeError(failure, 'L’enregistrement a échoué.'));
            throw failure;
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className={shell.section}>
            <p className={shell.sectionHint}>
                Ces paramètres s’ajoutent à l’adresse de destination. Les outils de mesure du site visé (Audience,
                Google Analytics, Matomo…) les lisent pour savoir d’où viennent les visiteurs : une lettre
                d’information, une affiche, un réseau social. Laissés vides, rien n’est ajouté.
            </p>

            <div className={styles.utmGrid}>
                {UTM_KEYS.map((key) => (
                    <div key={key} className={shell.field}>
                        <label className={shell.sectionLabel} htmlFor={`shortlinks-utm-${key}`}>
                            {FIELDS[key].label}
                        </label>
                        <TextInput
                            id={`shortlinks-utm-${key}`}
                            value={utm[key]}
                            maxLength={SHORTLINK_UTM_MAX}
                            placeholder={FIELDS[key].placeholder}
                            spellCheck={false}
                            disabled={!editable}
                            onChange={(event) => setUtm({ ...utm, [key]: event.target.value })}
                        />
                        <span className={shell.fieldHint}>
                            {FIELDS[key].hint} <code className={styles.paramName}>{UTM_PARAMS[key]}</code>
                        </span>
                    </div>
                ))}
            </div>

            <div className={shell.field}>
                <span className={shell.sectionLabel}>Le visiteur arrive sur</span>
                <span className={styles.preview}>{withUtm(link.targets.default, clean)}</span>
                {!hasUtm(clean) && (
                    <span className={shell.fieldHint}>La destination telle quelle, sans paramètre.</span>
                )}
                {(link.targets.ios !== null || link.targets.android !== null) && (
                    <span className={shell.fieldHint}>
                        Les mêmes paramètres s’ajoutent aux destinations propres à iPhone et à Android.
                    </span>
                )}
            </div>

            {canWrite ? (
                <SaveButton onSave={save} disabled={busy || unchanged} />
            ) : (
                <ReadOnlyNotice>
                    Votre rôle ne permet pas de modifier un lien : cela relève de l’écriture sur Liens courts.
                </ReadOnlyNotice>
            )}

            {error && <p className={shell.notice}>{error}</p>}
        </div>
    );
}
