/**
 * Les unités physiques. Calcul pur, fait dans le navigateur : rien ne part sur
 * le réseau. Une unité se ramène à l'unité de base de sa grandeur par
 * `valeur x factor + offset` ; le décalage ne sert qu'aux températures, qu'un
 * simple facteur rendrait fausses.
 */

export interface UnitSpec {
    id: string;
    label: string;
    symbol: string;
    factor: number;
    offset?: number;
}

export interface UnitCategory {
    id: string;
    label: string;
    units: readonly UnitSpec[];
}

export const UNIT_CATEGORIES: readonly UnitCategory[] = [
    {
        id: 'length',
        label: 'Longueur',
        units: [
            { id: 'mm', label: 'Millimètre', symbol: 'mm', factor: 0.001 },
            { id: 'cm', label: 'Centimètre', symbol: 'cm', factor: 0.01 },
            { id: 'm', label: 'Mètre', symbol: 'm', factor: 1 },
            { id: 'km', label: 'Kilomètre', symbol: 'km', factor: 1000 },
            { id: 'in', label: 'Pouce', symbol: 'in', factor: 0.0254 },
            { id: 'ft', label: 'Pied', symbol: 'ft', factor: 0.3048 },
            { id: 'yd', label: 'Yard', symbol: 'yd', factor: 0.9144 },
            { id: 'mi', label: 'Mile', symbol: 'mi', factor: 1609.344 },
            { id: 'nmi', label: 'Mille marin', symbol: 'NM', factor: 1852 }
        ]
    },
    {
        id: 'mass',
        label: 'Masse',
        units: [
            { id: 'mg', label: 'Milligramme', symbol: 'mg', factor: 0.000001 },
            { id: 'g', label: 'Gramme', symbol: 'g', factor: 0.001 },
            { id: 'kg', label: 'Kilogramme', symbol: 'kg', factor: 1 },
            { id: 't', label: 'Tonne', symbol: 't', factor: 1000 },
            { id: 'oz', label: 'Once', symbol: 'oz', factor: 0.028349523125 },
            { id: 'lb', label: 'Livre', symbol: 'lb', factor: 0.45359237 }
        ]
    },
    {
        id: 'temperature',
        label: 'Température',
        units: [
            { id: 'c', label: 'Celsius', symbol: '°C', factor: 1, offset: 273.15 },
            { id: 'f', label: 'Fahrenheit', symbol: '°F', factor: 5 / 9, offset: (459.67 * 5) / 9 },
            { id: 'k', label: 'Kelvin', symbol: 'K', factor: 1 }
        ]
    },
    {
        id: 'volume',
        label: 'Volume',
        units: [
            { id: 'ml', label: 'Millilitre', symbol: 'mL', factor: 0.001 },
            { id: 'cl', label: 'Centilitre', symbol: 'cL', factor: 0.01 },
            { id: 'l', label: 'Litre', symbol: 'L', factor: 1 },
            { id: 'm3', label: 'Mètre cube', symbol: 'm³', factor: 1000 },
            { id: 'tsp', label: 'Cuillère à café', symbol: 'c. à c.', factor: 0.005 },
            { id: 'tbsp', label: 'Cuillère à soupe', symbol: 'c. à s.', factor: 0.015 },
            { id: 'cup', label: 'Tasse (US)', symbol: 'cup', factor: 0.2365882365 },
            { id: 'floz', label: 'Once liquide (US)', symbol: 'fl oz', factor: 0.0295735295625 },
            { id: 'gal', label: 'Gallon (US)', symbol: 'gal', factor: 3.785411784 }
        ]
    },
    {
        id: 'area',
        label: 'Surface',
        units: [
            { id: 'cm2', label: 'Centimètre carré', symbol: 'cm²', factor: 0.0001 },
            { id: 'm2', label: 'Mètre carré', symbol: 'm²', factor: 1 },
            { id: 'ha', label: 'Hectare', symbol: 'ha', factor: 10_000 },
            { id: 'km2', label: 'Kilomètre carré', symbol: 'km²', factor: 1_000_000 },
            { id: 'ft2', label: 'Pied carré', symbol: 'ft²', factor: 0.09290304 },
            { id: 'ac', label: 'Acre', symbol: 'ac', factor: 4046.8564224 }
        ]
    },
    {
        id: 'speed',
        label: 'Vitesse',
        units: [
            { id: 'ms', label: 'Mètre par seconde', symbol: 'm/s', factor: 1 },
            { id: 'kmh', label: 'Kilomètre par heure', symbol: 'km/h', factor: 1 / 3.6 },
            { id: 'mph', label: 'Mile par heure', symbol: 'mph', factor: 0.44704 },
            { id: 'kn', label: 'Nœud', symbol: 'kn', factor: 1852 / 3600 }
        ]
    },
    {
        id: 'data',
        label: 'Données',
        units: [
            { id: 'b', label: 'Octet', symbol: 'o', factor: 1 },
            { id: 'kb', label: 'Kilooctet', symbol: 'ko', factor: 1000 },
            { id: 'mb', label: 'Mégaoctet', symbol: 'Mo', factor: 1000 ** 2 },
            { id: 'gb', label: 'Gigaoctet', symbol: 'Go', factor: 1000 ** 3 },
            { id: 'tb', label: 'Téraoctet', symbol: 'To', factor: 1000 ** 4 },
            { id: 'kib', label: 'Kibioctet', symbol: 'Kio', factor: 1024 },
            { id: 'mib', label: 'Mébioctet', symbol: 'Mio', factor: 1024 ** 2 },
            { id: 'gib', label: 'Gibioctet', symbol: 'Gio', factor: 1024 ** 3 },
            { id: 'tib', label: 'Tébioctet', symbol: 'Tio', factor: 1024 ** 4 }
        ]
    },
    {
        id: 'time',
        label: 'Durée',
        units: [
            { id: 's', label: 'Seconde', symbol: 's', factor: 1 },
            { id: 'min', label: 'Minute', symbol: 'min', factor: 60 },
            { id: 'h', label: 'Heure', symbol: 'h', factor: 3600 },
            { id: 'd', label: 'Jour', symbol: 'j', factor: 86_400 },
            { id: 'w', label: 'Semaine', symbol: 'sem.', factor: 604_800 }
        ]
    }
];

/** `null` quand l'une des deux unités n'appartient pas à la grandeur. */
export function convertUnit(category: UnitCategory, fromId: string, toId: string, value: number): number | null {
    const from = category.units.find((u) => u.id === fromId);
    const to = category.units.find((u) => u.id === toId);
    if (!from || !to) return null;
    const base = value * from.factor + (from.offset ?? 0);
    return (base - (to.offset ?? 0)) / to.factor;
}

/** Une parité entre deux devises, à partir des taux exprimés contre une même devise de référence. */
export function convertCurrency(
    rates: Readonly<Record<string, number>>,
    from: string,
    to: string,
    amount: number
): number | null {
    const fromRate = rates[from];
    const toRate = rates[to];
    if (!fromRate || !toRate) return null;
    return (amount / fromRate) * toRate;
}
