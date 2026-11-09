import { Button, SegmentedControl, Slider, Switch, TextArea } from 'deveye-sdk-client';

import { SignatureLibrary, type LibraryProps } from './SignatureLibrary';

import type { SavedSignature } from '../contracts/signatures';
import { CAN_REPEAT, ELEMENT_LABELS, HIGHLIGHT, textHeight, type HighlightColor, type PdfElement } from './elements';
import { InkPicker, type InkSlots } from './InkPicker';
import styles from './pdf.module.css';
import type { Tool } from './tools';

interface InspectorProps {
    element: PdfElement | null;
    tool: Tool;
    onChange: (patch: Partial<PdfElement>) => void;
    onRemove: () => void;
    /** Les signatures gardées, montrées avec l'outil Signature ou Paraphe, et sur une signature choisie. */
    library: LibraryProps;
    /** Une signature choisie en reproduit une autre du compte. */
    onSwapSignature: (saved: SavedSignature) => void;
    inks: InkSlots;
}

const HIGHLIGHT_OPTIONS = (Object.keys(HIGHLIGHT) as HighlightColor[]).map((value) => ({
    value,
    label: HIGHLIGHT[value].label
}));

const HINTS: Record<Tool, string> = {
    select: 'Cliquez un élément pour le modifier, glissez-le pour le déplacer, tirez un coin pour le redimensionner.',
    signature: 'Cliquez sur la page là où la signature doit se poser.',
    initials: 'Cliquez sur la page là où le paraphe doit se poser.',
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
export function Inspector({ element, tool, onChange, onRemove, library, onSwapSignature, inks }: InspectorProps) {
    if (!element) {
        return (
            <aside className={styles.inspector}>
                <p className={styles.inspectorHint}>{HINTS[tool]}</p>
                {(tool === 'signature' || tool === 'initials') && <SignatureLibrary role={tool} {...library} />}
            </aside>
        );
    }

    return (
        <aside className={styles.inspector} key={element.id}>
            <h3 className={styles.inspectorTitle}>
                {element.kind === 'signature' && element.role === 'initials' ? 'Paraphe' : ELEMENT_LABELS[element.kind]}
            </h3>

            {element.kind === 'text' && (
                <>
                    <Row label='Texte'>
                        <TextArea
                            value={element.text}
                            autoGrow
                            aria-label='Texte'
                            onChange={(e) =>
                                onChange({ text: e.target.value, height: textHeight(e.target.value, element.size) })
                            }
                        />
                    </Row>
                    <Slider
                        label='Taille (pt)'
                        min={6}
                        max={48}
                        step={1}
                        value={element.size}
                        editable
                        onChange={(size) => onChange({ size, height: textHeight(element.text, size) })}
                    />
                    <InkPicker value={element.color} onChange={(color) => onChange({ color })} {...inks} />
                    <Switch
                        label='Écriture manuscrite'
                        checked={element.hand}
                        onChange={(hand) => onChange({ hand })}
                    />
                </>
            )}

            {element.kind === 'signature' && (
                <>
                    <InkPicker value={element.color} onChange={(color) => onChange({ color })} {...inks} />
                    <SignatureLibrary
                        role={element.role}
                        {...library}
                        current={{ ...library.current, [element.role]: element.savedId }}
                        onPick={(_role, saved) => onSwapSignature(saved)}
                    />
                </>
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
                    <InkPicker value={element.color} onChange={(color) => onChange({ color })} {...inks} />
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
                    <Switch
                        label='Bordure'
                        checked={element.border !== null}
                        onChange={(on) => onChange({ border: on ? 'black' : null })}
                    />
                    {element.border !== null && (
                        <>
                            <InkPicker value={element.border} onChange={(border) => onChange({ border })} {...inks} />
                            <Slider
                                label='Épaisseur (pt)'
                                min={0.5}
                                max={8}
                                step={0.5}
                                value={element.stroke}
                                editable
                                onChange={(stroke) => onChange({ stroke })}
                            />
                        </>
                    )}
                </>
            )}

            {element.kind === 'ink' && (
                <>
                    <InkPicker value={element.color} onChange={(color) => onChange({ color })} {...inks} />
                    <Slider
                        label='Épaisseur (pt)'
                        min={1}
                        max={8}
                        step={0.5}
                        value={element.stroke}
                        editable
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
