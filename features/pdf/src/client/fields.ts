import type { FieldValue } from './build';
import { toView, type Frame, type Rect } from './geometry';
import type { PageBox } from './model';

/**
 * Les champs d'un formulaire, lus par pdf.js dans les annotations d'une page
 * et ramenés à ce que l'écran sait remplir. Le nom complet du champ est ce
 * que pdf-lib retrouve à l'assemblage.
 */

export type FieldKind = 'text' | 'checkbox' | 'radio' | 'choice';

export interface FormField {
    name: string;
    kind: FieldKind;
    /** Le rectangle du widget, dans le repère du fichier. */
    rect: PageBox;
    /** La valeur que le fichier porte déjà. Pour une case : cochée ou non. */
    value: FieldValue;
    /** Pour une case, la valeur qui la coche ; pour un bouton radio, la valeur de CE bouton. */
    onValue: string | null;
    options: readonly { value: string; label: string }[];
    readOnly: boolean;
    multiLine: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

const asText = (v: unknown): string => (typeof v === 'string' ? v : Array.isArray(v) ? String(v[0] ?? '') : '');

/** Les widgets remplissables parmi les annotations d'une page, dans l'ordre du fichier. */
export function fieldsOf(annotations: readonly unknown[]): FormField[] {
    const out: FormField[] = [];
    for (const raw of annotations) {
        if (!isRecord(raw) || raw.subtype !== 'Widget' || typeof raw.fieldName !== 'string' || raw.hidden === true)
            continue;
        const rect = raw.rect;
        if (!Array.isArray(rect) || rect.length !== 4 || !rect.every((n) => typeof n === 'number')) continue;
        const [x1, y1, x2, y2] = rect as number[];
        const box: PageBox = [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
        const base = {
            name: raw.fieldName,
            rect: box,
            readOnly: raw.readOnly === true,
            options: [] as FormField['options']
        };
        switch (raw.fieldType) {
            case 'Tx':
                out.push({
                    ...base,
                    kind: 'text',
                    value: asText(raw.fieldValue),
                    onValue: null,
                    multiLine: raw.multiLine === true
                });
                break;
            case 'Btn': {
                if (raw.pushButton === true) break;
                if (raw.radioButton === true) {
                    const on = typeof raw.buttonValue === 'string' ? raw.buttonValue : null;
                    out.push({ ...base, kind: 'radio', value: asText(raw.fieldValue), onValue: on, multiLine: false });
                    break;
                }
                const on = typeof raw.exportValue === 'string' ? raw.exportValue : 'Yes';
                out.push({
                    ...base,
                    kind: 'checkbox',
                    value: asText(raw.fieldValue) === on,
                    onValue: on,
                    multiLine: false
                });
                break;
            }
            case 'Ch': {
                const options = Array.isArray(raw.options)
                    ? raw.options.filter(isRecord).map((o) => ({
                          value: String(o.exportValue ?? o.displayValue ?? ''),
                          label: String(o.displayValue ?? o.exportValue ?? '')
                      }))
                    : [];
                out.push({
                    ...base,
                    kind: 'choice',
                    value: asText(raw.fieldValue),
                    onValue: null,
                    options,
                    multiLine: false
                });
                break;
            }
            default:
                break;
        }
    }
    return out;
}

/** Le rectangle du widget dans le cadre affiché. */
export function fieldViewRect(field: FormField, frame: Frame): Rect {
    const a = toView(frame, { x: field.rect[0], y: field.rect[1] });
    const b = toView(frame, { x: field.rect[2], y: field.rect[3] });
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
}

/** Un nom lisible pour un champ : « client.nom » devient « nom ». */
export const fieldLabel = (name: string): string => name.split('.').pop() || name;
