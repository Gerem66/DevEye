import { useEffect, useState } from 'react';
import { ws } from '@/api/ws';
import { useDialogSubmit } from '@/Components/Dialog';
import { openInfo } from '@/Components/InfoPopup';
import Button from '@/Components/Button';
import TextInput from '@/Components/TextInput';
import type { ShortcutItem, ShortcutPreview, ShortcutTemplate } from '@deveye/types';
import { addShortcut, updateShortcut } from '@/stores/homeLayout';
import { TemplateGallery } from './TemplateGallery';
import styles from './organize.module.css';

/** Human label per template (for the detected-type line + the info popup). */
const TEMPLATE_LABEL: Record<ShortcutTemplate, string> = {
    link: 'Lien',
    github: 'GitHub',
    youtube: 'YouTube',
    twitch: 'Twitch',
    twitter: 'X',
    instagram: 'Instagram',
    tiktok: 'TikTok',
    reddit: 'Reddit',
    linkedin: 'LinkedIn',
    spotify: 'Spotify',
    soundcloud: 'SoundCloud',
    discord: 'Discord',
    wikipedia: 'Wikipédia',
    medium: 'Medium',
    npm: 'npm',
    dribbble: 'Dribbble',
    pinterest: 'Pinterest',
    facebook: 'Facebook'
};

/** Domain → template, matched by host suffix (subdomains resolve too).
 *  Unmapped domains stay `link` (generic Open Graph + favicon). */
const DOMAIN_TEMPLATE: [string, ShortcutTemplate][] = [
    ['github.com', 'github'],
    ['youtube.com', 'youtube'],
    ['youtu.be', 'youtube'],
    ['twitch.tv', 'twitch'],
    ['x.com', 'twitter'],
    ['twitter.com', 'twitter'],
    ['instagram.com', 'instagram'],
    ['tiktok.com', 'tiktok'],
    ['reddit.com', 'reddit'],
    ['linkedin.com', 'linkedin'],
    ['open.spotify.com', 'spotify'],
    ['spotify.com', 'spotify'],
    ['soundcloud.com', 'soundcloud'],
    ['discord.com', 'discord'],
    ['discord.gg', 'discord'],
    ['wikipedia.org', 'wikipedia'],
    ['medium.com', 'medium'],
    ['npmjs.com', 'npm'],
    ['dribbble.com', 'dribbble'],
    ['pinterest.com', 'pinterest'],
    ['facebook.com', 'facebook']
];

function detectTemplate(url: string): ShortcutTemplate {
    let host: string;
    try {
        host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    } catch {
        return 'link';
    }
    for (const [domain, template] of DOMAIN_TEMPLATE) {
        if (host === domain || host.endsWith(`.${domain}`)) return template;
    }
    return 'link';
}

/** Add a default scheme when the user omits it; flag an explicit insecure http. */
function normalizeUrl(raw: string): { url: string; warnHttp: boolean } {
    const t = raw.trim();
    if (!t) return { url: '', warnHttp: false };
    if (/^https?:\/\//i.test(t)) return { url: t, warnHttp: /^http:\/\//i.test(t) };
    return { url: `https://${t.replace(/^\/+/, '')}`, warnHttp: false };
}

function isValidUrl(url: string): boolean {
    try {
        const u = new URL(url);
        return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname.includes('.');
    } catch {
        return false;
    }
}

/** Small on/off switch, matching the app's switch style. */
function Switch({
    checked,
    onChange,
    label,
    hint
}: {
    checked: boolean;
    onChange: (v: boolean) => void;
    label: string;
    hint?: string;
}) {
    return (
        <button
            type='button'
            role='switch'
            aria-checked={checked}
            className={`${styles.switch} ${checked ? styles.switchOn : ''}`}
            onClick={() => onChange(!checked)}
        >
            <span className={styles.switchTrack}>
                <span className={styles.switchThumb} />
            </span>
            <span className={styles.switchText}>
                {label}
                {hint && <span className={styles.switchHint}>{hint}</span>}
            </span>
        </button>
    );
}

function SupportedTemplates() {
    return (
        <div className={styles.infoBody}>
            <p>
                Le type d&apos;un raccourci est <strong>détecté automatiquement</strong> d&apos;après le domaine — pas
                besoin de le choisir. Trois cas :
            </p>
            <ul className={styles.infoList}>
                <li>
                    <strong>Données dédiées</strong> — GitHub (avatar, repos/abonnés ou étoiles/forks), YouTube,
                    Spotify, SoundCloud, TikTok (titre + miniature via oEmbed), Wikipédia (résumé) et npm (version,
                    téléchargements).
                </li>
                <li>
                    <strong>Tout autre lien</strong> (Twitch, X, Reddit, Instagram, blogs…) — aperçu Open Graph : titre,
                    description et image fournis par le site, plus son favicon comme logo.
                </li>
            </ul>
            <p>
                Activez <strong>« Traiter comme un lien simple »</strong> pour forcer ce dernier cas (utile si un site
                casse son aperçu).
            </p>
        </div>
    );
}

export interface ShortcutFormProps {
    /** Shortcut section the tile belongs to (created in / edited from). */
    sectionId: string;
    /** When set, the form edits this shortcut instead of creating a new one. */
    initial?: ShortcutItem;
    /** Called after a successful add/save (the dialog closes in edit mode). */
    onDone?: () => void;
}

/**
 * Create or edit a shortcut. The type is auto-detected from the URL's domain (no
 * manual list); a live, debounced preview shows the final tile as soon as the
 * URL is valid. A toggle forces a plain "simple link" preview, bypassing the
 * detected template.
 */
export function ShortcutForm({ sectionId, initial, onDone }: ShortcutFormProps) {
    const editing = !!initial;
    const [url, setUrl] = useState(initial?.url ?? '');
    const [title, setTitle] = useState(initial?.title ?? '');
    const [description, setDescription] = useState(initial?.description ?? '');
    // Reconstruct the "force simple" toggle: a stored `link` whose domain maps to
    // a real template means the user had forced it.
    const [forceSimple, setForceSimple] = useState(
        !!initial && initial.template === 'link' && detectTemplate(initial.url) !== 'link'
    );
    const [preview, setPreview] = useState<ShortcutPreview | null>(null);

    const { url: normUrl, warnHttp } = normalizeUrl(url);
    const valid = isValidUrl(normUrl);
    const template: ShortcutTemplate = forceSimple ? 'link' : detectTemplate(normUrl);
    const canSave = valid;

    // Live, debounced preview once the URL is valid; refreshes on URL/type change.
    useEffect(() => {
        if (!canSave) {
            setPreview(null);
            return;
        }
        let cancelled = false;
        const timer = setTimeout(() => {
            ws.send('home.shortcutPreview', { template, url: normUrl })
                .then((res) => {
                    if (!cancelled) setPreview(res);
                })
                .catch(() => {
                    if (!cancelled) setPreview(null);
                });
        }, 450);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [template, normUrl, canSave]);

    const submit = () => {
        if (!canSave) return;
        const draft = { template, url: normUrl, title: title.trim(), description: description.trim() || undefined };
        if (editing && initial) {
            updateShortcut(sectionId, initial.id, draft);
        } else {
            addShortcut(sectionId, draft);
            setUrl('');
            setTitle('');
            setDescription('');
            setForceSimple(false);
            setPreview(null);
        }
        onDone?.();
    };

    // Enter confirms when this form is hosted in a Dialog (add-tile / edit). The
    // submit itself no-ops while the URL is invalid.
    useDialogSubmit(submit);

    const previewSub = description.trim() || preview?.subtitle || null;
    const showTemplatesInfo = () =>
        void openInfo({ title: 'Détection automatique des liens', body: <SupportedTemplates />, width: 460 });
    const showTemplateGallery = () =>
        void openInfo({ title: 'Galerie de templates — test', body: <TemplateGallery />, width: 640 });

    return (
        <div className={styles.form}>
            <label className={styles.field}>
                <span className={styles.fieldLabel}>URL</span>
                <TextInput
                    type='text'
                    placeholder='github.com/utilisateur'
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                />
                {warnHttp && (
                    <span className={styles.fieldWarn}>Lien non sécurisé (http). Préférez https si possible.</span>
                )}
            </label>

            <label className={styles.field}>
                <span className={styles.fieldLabel}>Titre (optionnel)</span>
                <TextInput
                    placeholder={preview?.title || 'Sinon, le nom récupéré'}
                    value={title}
                    maxLength={80}
                    onChange={(e) => setTitle(e.target.value)}
                />
            </label>

            <label className={styles.field}>
                <span className={styles.fieldLabel}>Description (optionnelle)</span>
                <TextInput
                    placeholder='Note affichée sous le titre'
                    value={description}
                    maxLength={200}
                    onChange={(e) => setDescription(e.target.value)}
                />
            </label>

            <div className={styles.detectedRow}>
                <span className={styles.detectedText}>
                    Type&nbsp;: <strong>{TEMPLATE_LABEL[template]}</strong>
                    {!forceSimple && valid && <span className={styles.detectedHint}> · détecté automatiquement</span>}
                </span>
                <div className={styles.detectedActions}>
                    <button
                        type='button'
                        className={styles.infoBtn}
                        onClick={showTemplateGallery}
                        title='Tester tous les templates (exemples réels)'
                        aria-label='Tester tous les templates'
                    >
                        <span className='icon icon-sandbox' />
                    </button>
                    <button
                        type='button'
                        className={styles.infoBtn}
                        onClick={showTemplatesInfo}
                        title='Types de liens pris en charge'
                        aria-label='Types de liens pris en charge'
                    >
                        <span className='icon icon-info' />
                    </button>
                </div>
            </div>

            {canSave && (
                <div className={styles.previewCard}>
                    {preview?.imageUrl ? (
                        <img className={styles.previewImg} src={preview.imageUrl} alt='' referrerPolicy='no-referrer' />
                    ) : (
                        <span className={styles.previewIcon}>
                            <span className={`icon icon-other ${styles.previewGlyph}`} />
                        </span>
                    )}
                    <div className={styles.previewBody}>
                        <span className={styles.previewTitle}>{title.trim() || preview?.title || '…'}</span>
                        {previewSub && <span className={styles.previewSub}>{previewSub}</span>}
                        {preview && preview.stats.length > 0 && (
                            <span className={styles.previewStats}>
                                {preview.stats.map((s) => `${s.value} ${s.label}`).join(' · ')}
                            </span>
                        )}
                    </div>
                </div>
            )}

            <Switch
                checked={forceSimple}
                onChange={setForceSimple}
                label='Traiter comme un lien simple'
                hint='Ignore le template détecté.'
            />

            <div className={styles.formActions}>
                <Button variant='primary' icon={editing ? 'check-circle' : 'plus'} onClick={submit} disabled={!canSave}>
                    {editing ? 'Enregistrer' : 'Ajouter le raccourci'}
                </Button>
            </div>
        </div>
    );
}

export default ShortcutForm;
