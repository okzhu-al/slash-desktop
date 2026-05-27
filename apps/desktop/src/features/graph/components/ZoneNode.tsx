import { memo } from 'react';
import { NodeProps } from '@xyflow/react';
import { CATEGORY_COLORS } from '../constants';
import { useTranslation } from 'react-i18next';

function ZoneNodeComponent({ data }: NodeProps) {
    const category = (data.category as string) || 'inbox';
    const width = data.width as number;
    const height = data.height as number;
    const { t } = useTranslation();

    const color = CATEGORY_COLORS[category] || CATEGORY_COLORS.resource;
    const title = t(`graph.category.${category}`, category.charAt(0).toUpperCase() + category.slice(1));

    return (
        <div
            className="rounded-3xl border border-dashed transition-all duration-500 overflow-hidden"
            style={{
                width,
                height,
                backgroundColor: `${color}15`, // 10-15% opacity background
                borderColor: `${color}40`,     // 25% opacity border
                zIndex: -1,
            }}
        >
            <div 
                className="absolute top-4 outline-none font-semibold tracking-wider text-[40px] uppercase opacity-20"
                style={{ color, left: '50%', transform: 'translateX(-50%)' }}
            >
                {title}
            </div>
        </div>
    );
}

export const ZoneNode = memo(ZoneNodeComponent);
