/**
 * Ce que les feuilles de style chargées déclarent, lu à l'exécution : la
 * galerie montre le thème tel qu'il est, sans liste à tenir à jour.
 */

function walk(rules: CSSRuleList, visit: (rule: CSSStyleRule) => void): void {
    for (const rule of Array.from(rules)) {
        if (rule instanceof CSSStyleRule) visit(rule);
        if ('cssRules' in rule && rule.cssRules) walk(rule.cssRules as CSSRuleList, visit);
    }
}

function eachRule(visit: (rule: CSSStyleRule) => void): void {
    for (const sheet of Array.from(document.styleSheets)) {
        let rules: CSSRuleList;
        try {
            rules = sheet.cssRules;
        } catch {
            // Une feuille d'une autre origine (polices) ne se lit pas.
            continue;
        }
        walk(rules, visit);
    }
}

export type TokenKind = 'color' | 'length' | 'shadow' | 'font' | 'other';

export interface ThemeToken {
    name: string;
    value: string;
    kind: TokenKind;
    /** Le premier segment du nom : `--accent-hover` range dans `accent`. */
    group: string;
}

function kindOf(name: string, value: string): TokenKind {
    if (name.startsWith('--shadow')) return 'shadow';
    if (name.startsWith('--font')) return 'font';
    if (CSS.supports('color', value)) return 'color';
    if (/^-?[\d.]+(px|rem|em|%)$/.test(value)) return 'length';
    return 'other';
}

/** Les jetons posés sur `:root`, avec leur valeur calculée dans le thème affiché. */
export function themeTokens(): ThemeToken[] {
    const names = new Set<string>();
    eachRule((rule) => {
        if (!rule.selectorText.split(',').some((s) => s.trim().startsWith(':root'))) return;
        for (let i = 0; i < rule.style.length; i++) {
            const property = rule.style[i];
            if (property.startsWith('--')) names.add(property);
        }
    });
    const computed = getComputedStyle(document.documentElement);
    return [...names].sort().map((name) => {
        const value = computed.getPropertyValue(name).trim();
        return { name, value, kind: kindOf(name, value), group: name.slice(2).split('-')[0] };
    });
}

/** Les icônes déclarées (`.icon-<nom>`), triées. */
export function iconNames(): string[] {
    const names = new Set<string>();
    eachRule((rule) => {
        for (const match of rule.selectorText.matchAll(/\.icon-([a-z0-9-]+)/g)) names.add(match[1]);
    });
    return [...names].sort();
}
