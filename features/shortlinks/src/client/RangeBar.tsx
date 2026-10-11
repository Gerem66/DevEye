import { SegmentedControl } from 'deveye-sdk-client';

import type { ShortlinkRange } from '../contracts/domain';
import { RANGE_LABELS, RANGE_TITLES, RANGES } from './format';

/** Les périodes offertes, du plus près au plus loin. */
export default function RangeBar({
    value,
    onChange
}: {
    value: ShortlinkRange;
    onChange: (range: ShortlinkRange) => void;
}) {
    return (
        <SegmentedControl
            value={value}
            options={RANGES.map((range) => ({ value: range, label: RANGE_LABELS[range], title: RANGE_TITLES[range] }))}
            onChange={onChange}
            aria-label='Période'
        />
    );
}
