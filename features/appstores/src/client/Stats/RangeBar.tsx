import { SegmentedControl } from 'deveye-sdk-client';
import type { AppStoresRange } from '../../contracts/domain';

import { RANGE_LABELS, RANGE_TITLES, RANGES } from '../format';

interface RangeBarProps {
    value: AppStoresRange;
    onChange: (range: AppStoresRange) => void;
}

/** Les fenêtres offertes, une seule pour tous les onglets de la fiche. */
export function RangeBar({ value, onChange }: RangeBarProps) {
    return (
        <SegmentedControl
            value={value}
            options={RANGES.map((range) => ({ value: range, label: RANGE_LABELS[range], title: RANGE_TITLES[range] }))}
            onChange={onChange}
            aria-label='Période'
        />
    );
}

export default RangeBar;
