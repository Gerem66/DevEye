import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Checkbox, NumberInput, SegmentedControl, Slider, Switch, TextInput } from 'deveye-sdk-client';

import {
    NUMBER_ALIGNS,
    NUMBER_EDGES,
    NUMBER_FORMATS,
    NUMBER_MARGIN,
    NUMBER_SIZE,
    numberBox,
    pageNumberLabel,
    splitPosition,
    WATERMARK_ANGLE,
    WATERMARK_MAX_SIZE,
    WATERMARK_MIN_SIZE,
    type Finishing
} from './finishing';
import { displayedSize, type Plan } from './model';
import styles from './pdf.module.css';
import { thumbnail } from './thumbnails';
import type { Workshop } from './usePdfWorkshop';

const PREVIEW_WIDTH = 320;

/** La première page, avec le numéro et le filigrane tels qu'ils sortiront. */
function Preview({ plan, finishing }: { plan: Plan; finishing: Finishing }) {
    const page = plan.pages[finishing.numbers.skipFirst && plan.pages.length > 1 ? 1 : 0] ?? null;
    const index = page ? plan.pages.indexOf(page) : 0;
    const [url, setUrl] = useState<string | null>(null);
    const wrap = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!page) return;
        let cancelled = false;
        thumbnail(page, plan, PREVIEW_WIDTH)
            .then((u) => {
                if (!cancelled) setUrl(u);
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, [page, plan]);
    if (!page) return null;
    const size = displayedSize(page, plan);
    const scale = PREVIEW_WIDTH / size.width;
    const label = pageNumberLabel(finishing.numbers, index, plan.pages.length);
    // La largeur du numéro est approchée : six points par caractère à dix points.
    const box = label === null ? null : numberBox(finishing.numbers.position, size, label.length * 5.5, NUMBER_SIZE);
    const watermark = finishing.watermark.on && finishing.watermark.text.trim() !== '';
    return (
        <div ref={wrap} className={styles.finishPreview} style={{ width: PREVIEW_WIDTH, height: size.height * scale }}>
            {url && <img className={styles.stageImage} src={url} alt='' draggable={false} />}
            {box && label !== null && (
                <span
                    className={styles.previewNumber}
                    style={{ left: box.x * scale, top: box.y * scale, fontSize: NUMBER_SIZE * scale, lineHeight: 1 }}
                >
                    {label}
                </span>
            )}
            {watermark && (
                <span
                    className={styles.previewWatermark}
                    style={
                        {
                            fontSize: finishing.watermark.size * scale,
                            opacity: finishing.watermark.opacity,
                            transform: `translate(-50%, -50%) rotate(${finishing.watermark.diagonal ? -WATERMARK_ANGLE : 0}deg)`
                        } as CSSProperties
                    }
                >
                    {finishing.watermark.text.trim()}
                </span>
            )}
            <span className={styles.previewMargin} style={{ inset: NUMBER_MARGIN * scale }} aria-hidden='true' />
        </div>
    );
}

interface FinishTabProps {
    workshop: Workshop;
}

/** Numéros de page, filigrane, propriétés et mot de passe du document produit. */
export function FinishTab({ workshop }: FinishTabProps) {
    const { plan, finishing, act } = workshop;
    const set = (patch: Partial<Finishing>) => act('setFinishing', { patch });
    const { numbers, watermark, metadata } = finishing;
    const first = plan.sources[0]?.meta ?? { title: '', author: '', subject: '' };
    const [confirm, setConfirm] = useState('');
    const password = finishing.password ?? '';
    const mismatch = password !== '' && confirm !== '' && confirm !== password;

    return (
        <div className={styles.finishTab}>
            <div className={styles.finishSections}>
                <section className={styles.finishSection}>
                    <Switch
                        label='Numéroter les pages'
                        hint='En petit, dans la marge.'
                        checked={numbers.on}
                        onChange={(on) => set({ numbers: { ...numbers, on } })}
                    />
                    {numbers.on && (
                        <div className={styles.finishFields}>
                            <div className={styles.finishPair}>
                                <div className={styles.inspectorRow}>
                                    <span className={styles.inspectorLabel}>Position</span>
                                    <SegmentedControl
                                        value={splitPosition(numbers.position).edge}
                                        options={NUMBER_EDGES}
                                        onChange={(edge) =>
                                            set({
                                                numbers: {
                                                    ...numbers,
                                                    position: `${edge}-${splitPosition(numbers.position).align}`
                                                }
                                            })
                                        }
                                        fullWidth
                                        aria-label='Bord de la page'
                                    />
                                </div>
                                <div className={styles.inspectorRow}>
                                    <span className={styles.inspectorLabel}>Alignement</span>
                                    <SegmentedControl
                                        value={splitPosition(numbers.position).align}
                                        options={NUMBER_ALIGNS}
                                        onChange={(align) =>
                                            set({
                                                numbers: {
                                                    ...numbers,
                                                    position: `${splitPosition(numbers.position).edge}-${align}`
                                                }
                                            })
                                        }
                                        fullWidth
                                        aria-label='Alignement du numéro'
                                    />
                                </div>
                            </div>
                            <div className={styles.inspectorRow}>
                                <span className={styles.inspectorLabel}>Format</span>
                                <SegmentedControl
                                    value={numbers.format}
                                    options={NUMBER_FORMATS}
                                    onChange={(format) => set({ numbers: { ...numbers, format } })}
                                    fullWidth
                                />
                            </div>
                            <div className={styles.finishPair}>
                                <label className={styles.inspectorRow} htmlFor='pdf-number-start'>
                                    <span className={styles.inspectorLabel}>Premier numéro</span>
                                    <NumberInput
                                        id='pdf-number-start'
                                        value={numbers.start}
                                        min={0}
                                        max={9999}
                                        onChange={(start) => set({ numbers: { ...numbers, start: start ?? 1 } })}
                                    />
                                </label>
                                <Checkbox
                                    checked={numbers.skipFirst}
                                    onChange={(skipFirst) => set({ numbers: { ...numbers, skipFirst } })}
                                >
                                    Sauter la première page
                                </Checkbox>
                            </div>
                        </div>
                    )}
                </section>

                <section className={styles.finishSection}>
                    <Switch
                        label='Filigrane'
                        hint='Un mot en travers de chaque page : « Copie », « Confidentiel ».'
                        checked={watermark.on}
                        onChange={(on) => set({ watermark: { ...watermark, on } })}
                    />
                    {watermark.on && (
                        <div className={styles.finishFields}>
                            <TextInput
                                value={watermark.text}
                                maxLength={60}
                                aria-label='Texte du filigrane'
                                onChange={(e) => set({ watermark: { ...watermark, text: e.target.value } })}
                            />
                            <Slider
                                label='Taille'
                                min={WATERMARK_MIN_SIZE}
                                max={WATERMARK_MAX_SIZE}
                                step={4}
                                value={watermark.size}
                                valueLabel={`${watermark.size} pt`}
                                onChange={(size) => set({ watermark: { ...watermark, size } })}
                            />
                            <Slider
                                label='Opacité'
                                min={5}
                                max={60}
                                step={5}
                                value={Math.round(watermark.opacity * 100)}
                                valueLabel={`${Math.round(watermark.opacity * 100)} %`}
                                onChange={(pct) => set({ watermark: { ...watermark, opacity: pct / 100 } })}
                            />
                            <SegmentedControl
                                value={watermark.diagonal ? 'diagonal' : 'straight'}
                                options={[
                                    { value: 'diagonal', label: 'En travers' },
                                    { value: 'straight', label: 'Droit' }
                                ]}
                                onChange={(v) => set({ watermark: { ...watermark, diagonal: v === 'diagonal' } })}
                                fullWidth
                                aria-label='Orientation du filigrane'
                            />
                        </div>
                    )}
                </section>

                <section className={styles.finishSection}>
                    <h3 className={styles.inspectorTitle}>Propriétés du document</h3>
                    <div className={styles.finishFields}>
                        <label className={styles.inspectorRow}>
                            <span className={styles.inspectorLabel}>Titre</span>
                            <TextInput
                                value={metadata.title}
                                placeholder={first.title}
                                maxLength={200}
                                disabled={metadata.strip}
                                onChange={(e) => set({ metadata: { ...metadata, title: e.target.value } })}
                            />
                        </label>
                        <label className={styles.inspectorRow}>
                            <span className={styles.inspectorLabel}>Auteur</span>
                            <TextInput
                                value={metadata.author}
                                placeholder={first.author}
                                maxLength={200}
                                disabled={metadata.strip}
                                onChange={(e) => set({ metadata: { ...metadata, author: e.target.value } })}
                            />
                        </label>
                        <label className={styles.inspectorRow}>
                            <span className={styles.inspectorLabel}>Sujet</span>
                            <TextInput
                                value={metadata.subject}
                                placeholder={first.subject}
                                maxLength={200}
                                disabled={metadata.strip}
                                onChange={(e) => set({ metadata: { ...metadata, subject: e.target.value } })}
                            />
                        </label>
                        <Checkbox
                            checked={metadata.strip}
                            onChange={(strip) => set({ metadata: { ...metadata, strip } })}
                        >
                            Retirer toutes les informations du document
                        </Checkbox>
                        {!metadata.strip && (first.title || first.author) && (
                            <p className={styles.note}>Un champ vide garde ce que le premier fichier disait.</p>
                        )}
                    </div>
                </section>

                <section className={styles.finishSection}>
                    <Switch
                        label='Protéger par un mot de passe'
                        hint='Il faudra le saisir pour ouvrir le document.'
                        checked={finishing.password !== null}
                        onChange={(on) => {
                            set({ password: on ? '' : null });
                            setConfirm('');
                        }}
                    />
                    {finishing.password !== null && (
                        <div className={styles.finishFields}>
                            <TextInput
                                type='password'
                                value={password}
                                enableShowHideButton
                                autoComplete='new-password'
                                aria-label='Mot de passe'
                                placeholder='Mot de passe'
                                onChange={(e) => set({ password: e.target.value })}
                            />
                            <TextInput
                                type='password'
                                value={confirm}
                                autoComplete='new-password'
                                aria-label='Confirmer le mot de passe'
                                placeholder='Encore une fois'
                                error={mismatch ? 'différent' : undefined}
                                onChange={(e) => setConfirm(e.target.value)}
                            />
                            {mismatch && (
                                <p className={styles.fieldError} role='alert'>
                                    Les deux saisies diffèrent.
                                </p>
                            )}
                            <p className={styles.note}>
                                Chiffré en AES-256 : sans le mot de passe, personne ne lit le document, pas même nous.
                                Ne le perdez pas.
                            </p>
                        </div>
                    )}
                </section>
            </div>
            <div className={styles.finishAside}>
                <h3 className={styles.inspectorTitle}>Aperçu</h3>
                <Preview plan={plan} finishing={finishing} />
            </div>
        </div>
    );
}
