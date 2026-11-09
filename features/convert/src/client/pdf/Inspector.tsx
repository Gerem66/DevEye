import { Button, SegmentedControl, Slider, Switch, TextArea } from 'deveye-sdk-client';

import {
    CAN_REPEAT,
    ELEMENT_LABELS,
    HIGHLIGHT,
    INK,
    textHeight,
    type HighlightColor,
    type InkColor,
    type PdfElement
} from './elements';
import styles from './pdf.module.css';
import type { Tool } from './tools';

interface InspectorProps {
    element: PdfElement | null;
    tool: Tool;
    onChange: (patch: Partial<PdfElement>) => void;
    onRemove: () => void;
    /** Rouvrir le dialogue d'une signature ou d'un paraphe déjà choisis. */
    onChangeSignature: (role: 'signature' | 'initials') => void;
}

const INK_OPTIONS = (Object.keys(INK) as InkColor[]).map((value) => ({ value, label: INK[value].label }));
const HIGHLIGHT_OPTIONS = (Object.keys(HIGHLIGHT) as HighlightColor[]).map((value) => ({
    value,
    label: HIGHLIGHT[value].label
}));

const HINTS: Record<Tool, string> = {
    select: 'Cliquez un élément pour le modifier, glissez-le pour le déplacer, tirez un coin pour le redimensionner.',
    signature: 'Cliquez sur la page là où la signature doit se poser.',
    initials: 'Cliquez sur la page : le paraphe se pose au même endroit sur toutes les pages.',
    text: 'Cliquez sur la page pour y écrire.',
    date: 'Cliquez sur la page pour y poser la date du jour.',
    check: 'Cliquez sur la case à cocher.',
    cross: 'Cliquez là où la croix doit se poser.',
    image: 'Cliquez sur la page là où l’image doit se poser.',
    highlight: 'Tracez un rectangle sur le passage à surligner.',
    box: 'Tracez un rectangle : encadré, ou blanc pour couvrir.',
    ink: 'Dessinez sur la page.',
    redact: 'Tracez un rectangle sur ce qui doit disparaître. La page entière deviendra une image.'
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className={styles.inspectorRow}>
            <span className={styles.inspectorLabel}>{label}</span>
            {children}
        </div>
    );
}

/** Les réglages de l'élément choisi, ou ce que l'outil attend. */
export function Inspector({ element, tool, onChange, onRemove, onChangeSignature }: InspectorProps) {
    if (!element) {
        return (
            <aside className={styles.inspector}>
                <p className={styles.inspectorHint}>{HINTS[tool]}</p>
                {(tool === 'signature' || tool === 'initials') && (
                    <Button variant='secondary' onClick={() => onChangeSignature(tool)}>
                        {tool === 'signature' ? 'Changer de signature' : 'Changer de paraphe'}
                    </Button>
                )}
            </aside>
        );
    }

    return (
        <aside className={styles.inspector} key={element.id}>
            <h3 className={styles.inspectorTitle}>{ELEMENT_LABELS[element.kind]}</h3>

            {element.kind === 'text' && (
                <>
                    <Row label='Texte'>
                        <TextArea
                            value={element.text}
                            autoGrow
                            autoFocus
                            aria-label='Texte'
                            onChange={(e) =>
                                onChange({ text: e.target.value, height: textHeight(e.target.value, element.size) })
                            }
                        />
                    </Row>
                    <Slider
                        label='Taille'
                        min={6}
                        max={48}
                        step={1}
                        value={element.size}
                        valueLabel={`${element.size} pt`}
                        onChange={(size) => onChange({ size, height: textHeight(element.text, size) })}
                    />
                    <Row label='Encre'>
                        <SegmentedControl
                            value={element.color}
                            options={INK_OPTIONS}
                            onChange={(color) => onChange({ color })}
                            fullWidth
                        />
                    </Row>
                    <Switch
                        label='Écriture manuscrite'
                        checked={element.hand}
                        onChange={(hand) => onChange({ hand })}
                    />
                </>
            )}

            {element.kind === 'signature' && (
                <Row label='Encre'>
                    <SegmentedControl
                        value={element.color}
                        options={INK_OPTIONS}
                        onChange={(color) => onChange({ color })}
                        fullWidth
                    />
                </Row>
            )}

            {element.kind === 'mark' && (
                <>
                    <Row label='Forme'>
                        <SegmentedControl
                            value={element.mark}
                            options={[
                                { value: 'check', label: 'Coche' },
                                { value: 'cross', label: 'Croix' }
                            ]}
                            onChange={(mark) => onChange({ mark })}
                            fullWidth
                        />
                    </Row>
                    <Row label='Encre'>
                        <SegmentedControl
                            value={element.color}
                            options={INK_OPTIONS}
                            onChange={(color) => onChange({ color })}
                            fullWidth
                        />
                    </Row>
                </>
            )}

            {element.kind === 'highlight' && (
                <Row label='Couleur'>
                    <SegmentedControl
                        value={element.color}
                        options={HIGHLIGHT_OPTIONS}
                        onChange={(color) => onChange({ color })}
                        fullWidth
                    />
                </Row>
            )}

            {element.kind === 'box' && (
                <>
                    <Row label='Fond'>
                        <SegmentedControl
                            value={element.fill}
                            options={[
                                { value: 'none', label: 'Transparent' },
                                { value: 'white', label: 'Blanc', title: 'Couvre ce qu’il y a dessous' }
                            ]}
                            onChange={(fill) => onChange({ fill })}
                            fullWidth
                        />
                    </Row>
                    <Row label='Bordure'>
                        <SegmentedControl
                            value={element.border ?? 'none'}
                            options={[{ value: 'none', label: 'Aucune' }, ...INK_OPTIONS]}
                            onChange={(border) => onChange({ border: border === 'none' ? null : border })}
                            fullWidth
                        />
                    </Row>
                </>
            )}

            {element.kind === 'ink' && (
                <>
                    <Row label='Encre'>
                        <SegmentedControl
                            value={element.color}
                            options={INK_OPTIONS}
                            onChange={(color) => onChange({ color })}
                            fullWidth
                        />
                    </Row>
                    <Slider
                        label='Épaisseur'
                        min={1}
                        max={8}
                        step={0.5}
                        value={element.stroke}
                        valueLabel={`${element.stroke} pt`}
                        onChange={(stroke) => onChange({ stroke })}
                    />
                </>
            )}

            {element.kind === 'redact' && (
                <p className={styles.inspectorNote}>
                    Ce qui est sous ce rectangle disparaît pour de bon : à l’export, la page entière devient une image,
                    et son texte ne se copie plus.
                </p>
            )}

            {CAN_REPEAT.includes(element.kind) && (
                <Switch
                    label='Sur toutes les pages'
                    hint='Au même endroit, à la même distance des bords.'
                    checked={element.everyPage}
                    onChange={(everyPage) => onChange({ everyPage })}
                />
            )}

            <div className={styles.inspectorActions}>
                <Button variant='ghost' icon='trash' onClick={onRemove}>
                    Retirer
                </Button>
            </div>
        </aside>
    );
}
