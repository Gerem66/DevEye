import { Picto } from './icons';
import type { Ink } from './elements';
import { InkPicker, type InkSlots } from './InkPicker';
import styles from './pdf.module.css';
import { TOOLS, type Tool } from './tools';

interface ToolBarProps {
    index: number;
    count: number;
    onGo: (index: number) => void;
    tool: Tool;
    onTool: (tool: Tool) => void;
    color: Ink;
    onColor: (color: Ink) => void;
    inks: InkSlots;
}

/** La page en cours, les outils, et l'encre des prochains éléments. */
export function ToolBar({ index, count, onGo, tool, onTool, color, onColor, inks }: ToolBarProps) {
    return (
        <div className={styles.toolbar}>
            <div className={styles.pageNav}>
                <button
                    type='button'
                    className={styles.iconButton}
                    aria-label='Page précédente'
                    title='Page précédente'
                    disabled={index <= 0}
                    onClick={() => onGo(index - 1)}
                >
                    <Picto id='prev' size={16} />
                </button>
                <span className={styles.pageNavLabel} aria-live='polite'>
                    {index + 1} / {count}
                </span>
                <button
                    type='button'
                    className={styles.iconButton}
                    aria-label='Page suivante'
                    title='Page suivante'
                    disabled={index >= count - 1}
                    onClick={() => onGo(index + 1)}
                >
                    <Picto id='next' size={16} />
                </button>
            </div>
            <div className={styles.tools} role='toolbar' aria-label='Outils'>
                {TOOLS.map((t) => (
                    <button
                        key={t.id}
                        type='button'
                        className={`${styles.toolButton} ${t.id === tool ? styles.toolActive : ''}`}
                        aria-pressed={t.id === tool}
                        title={t.title}
                        onClick={() => onTool(t.id)}
                    >
                        <Picto id={t.picto} size={18} />
                        <span className={styles.toolLabel}>{t.label}</span>
                    </button>
                ))}
            </div>
            <div className={styles.toolbarInk}>
                <InkPicker value={color} onChange={onColor} {...inks} />
            </div>
        </div>
    );
}
