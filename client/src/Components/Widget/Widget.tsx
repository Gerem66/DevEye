import { forwardRef, type CSSProperties, type ElementType, type ReactNode, type MouseEvent } from 'react';
import { motion, type HTMLMotionProps } from 'framer-motion';
import { useLiveOutline } from '@/live/useLiveOutline';
import { safeHref } from '@/safeHref';
import { useWorkspaceState } from '@/stores/workspace';
import styles from './Widget.module.css';

export interface WidgetProps extends Omit<HTMLMotionProps<'div'>, 'children'> {
    /** Unique ID used as framer-motion layoutId for shared-element transitions. */
    widgetId: string;
    /** Widget heading/title shown in the header. */
    title?: string;
    /** Optional icon (name) displayed before the title. */
    icon?: string;
    /** Une pastille à droite du titre : un état de la feature, pas du contenu. */
    badge?: ReactNode;
    /** Content rendered inside the widget body. */
    children?: ReactNode;
    /** Called when the widget is clicked (e.g., to expand into popup). */
    onExpand?: (e: React.MouseEvent<HTMLDivElement>) => void;
    /** Additional className for the outer wrapper. */
    className?: string;
    /** Carte courte : appareils et raccourcis, à une seule hauteur puisqu'une
     *  même ligne peut les mêler. */
    compact?: boolean;
    /**
     * Interactive (default): morphs via `layoutId`, lifts on hover, opens on
     * click. Set false for edit-mode cards — drops the morph/hover/click and the
     * expand hint so the card is a plain, drag-friendly surface.
     */
    interactive?: boolean;
    /**
     * When set, the card renders as an anchor opening this URL in a new tab — so
     * the browser shows the link on hover (status bar) and supports middle-click.
     * Used by shortcut tiles instead of a JS click handler.
     */
    href?: string;
}

/**
 * Glassmorphism widget card. Uses framer-motion `layoutId` for smooth expansion
 * into a popup. Clicking anywhere triggers `onExpand`.
 */
const Widget = forwardRef<HTMLDivElement, WidgetProps>(function Widget(
    { widgetId, title, icon, badge, children, onExpand, className, compact, interactive = true, href, ...motionProps },
    ref
) {
    // Présence : la tuile s'entoure de la couleur de qui se trouve dans la
    // feature qu'elle ouvre. Posé ici pour toutes les tuiles, le `widgetId`
    // étant le segment de vue.
    const outline = useLiveOutline('view', widgetId);

    // L'identité de morphe est portée par l'espace : sans ce préfixe, une tuile
    // remontée après une bascule reprenait celle d'une popup restée ouverte, et
    // framer-motion projetait la popup dans la tuile.
    const { epoch: workspaceEpoch } = useWorkspaceState();
    const layoutKey = `${workspaceEpoch}:${widgetId}`;

    // Render as an anchor when `href` is set, else a div. Typed loosely so the
    // motion props + click handler aren't constrained to the div/anchor union.
    const link = safeHref(href);
    const Tag = (link ? motion.a : motion.div) as ElementType;
    const linkProps = link ? { href: link, target: '_blank', rel: 'noopener noreferrer' } : undefined;
    return (
        <Tag
            ref={ref as never}
            layoutId={interactive ? layoutKey : undefined}
            className={`${styles.widget} ${compact ? styles.compact : ''} ${interactive ? '' : styles.static} ${className ?? ''}`}
            onClick={interactive && !link ? (e: MouseEvent<HTMLDivElement>) => onExpand?.(e) : undefined}
            // Maj+clic rouvre la vue à neuf : sans cela, le navigateur étend
            // aussi la sélection de texte jusqu'au point cliqué.
            onMouseDown={
                interactive
                    ? (e: MouseEvent) => {
                          if (e.shiftKey) e.preventDefault();
                      }
                    : undefined
            }
            whileHover={interactive ? { y: -4 } : undefined}
            whileTap={interactive ? { scale: 0.985 } : undefined}
            transition={{ type: 'spring', stiffness: 300, damping: 26, mass: 0.8 }}
            {...linkProps}
            {...(motionProps as object)}
            {...outline}
            // Fusionné plutôt qu'écrasé : l'accueil pose déjà un `style` sur la
            // tuile en cours d'agrandissement (opacité 0 pendant le morphe).
            style={{ ...(motionProps.style as CSSProperties | undefined), ...outline.style }}
        >
            {title && (
                <div className={styles.header}>
                    {icon && (
                        <span className={styles.iconWrap}>
                            <span className={`icon icon-${icon} ${styles.icon}`} />
                        </span>
                    )}
                    <span className={styles.title}>{title}</span>
                    {badge && <span className={styles.badge}>{badge}</span>}
                    {interactive && (
                        <span className={styles.headerMark}>
                            <span className={`icon icon-arrow ${styles.expandHint}`} aria-hidden='true' />
                        </span>
                    )}
                </div>
            )}
            <div className={styles.body}>{children}</div>
        </Tag>
    );
});

export default Widget;
