/**
 * DatePicker - Calendar popup for task due date selection
 * 
 * Features:
 * - Month/Year navigation
 * - Today highlight
 * - Clear date option
 * - Positioned relative to anchor element
 */

import React, { useState, useEffect, useRef } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface DatePickerProps {
    value: string | null;
    onChange: (date: string | null) => void;
    onClose: () => void;
}

export const DatePicker: React.FC<DatePickerProps> = ({
    value,
    onChange,
    onClose,
}) => {
    const [viewDate, setViewDate] = useState(() => {
        if (value) return new Date(value);
        return new Date();
    });
    const containerRef = useRef<HTMLDivElement>(null);
    const { t, i18n } = useTranslation();
    const lang = i18n.language || 'zh-CN';

    // Dynamically generate localized strings
    const MONTHS = Array.from({ length: 12 }, (_, i) => {
        return new Intl.DateTimeFormat(lang, { month: 'long' }).format(new Date(2000, i, 1));
    });
    const WEEKDAYS = Array.from({ length: 7 }, (_, i) => {
        return new Intl.DateTimeFormat(lang, { weekday: 'short' }).format(new Date(2023, 0, 1 + i)); // 2023-01-01 is Sunday
    });

    // Close on click outside
    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                onClose();
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [onClose]);

    // Close on Escape
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [onClose]);

    const year = viewDate.getFullYear();
    const month = viewDate.getMonth();

    // Get days in current month view
    const firstDayOfMonth = new Date(year, month, 1);
    const lastDayOfMonth = new Date(year, month + 1, 0);
    const startDay = firstDayOfMonth.getDay();
    const daysInMonth = lastDayOfMonth.getDate();

    // Generate calendar grid
    const calendarDays: (number | null)[] = [];
    for (let i = 0; i < startDay; i++) {
        calendarDays.push(null);
    }
    for (let day = 1; day <= daysInMonth; day++) {
        calendarDays.push(day);
    }

    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    const selectedDateStr = value;

    const handleDateClick = (day: number) => {
        const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        onChange(dateStr);
    };

    const handlePrevMonth = () => {
        setViewDate(new Date(year, month - 1, 1));
    };

    const handleNextMonth = () => {
        setViewDate(new Date(year, month + 1, 1));
    };

    const handleToday = () => {
        onChange(todayStr);
    };

    const handleClear = () => {
        onChange(null);
    };

    return (
        <div ref={containerRef} className="date-picker">
            {/* Header */}
            <div className="date-picker-header">
                <button onClick={handlePrevMonth} className="date-picker-nav">
                    <ChevronLeft size={16} />
                </button>
                <span className="date-picker-title">
                    {MONTHS[month]} {year}
                </span>
                <button onClick={handleNextMonth} className="date-picker-nav">
                    <ChevronRight size={16} />
                </button>
            </div>

            {/* Weekday headers */}
            <div className="date-picker-weekdays">
                {WEEKDAYS.map((day) => (
                    <div key={day} className="date-picker-weekday">
                        {day}
                    </div>
                ))}
            </div>

            {/* Calendar grid */}
            <div className="date-picker-grid">
                {calendarDays.map((day, index) => {
                    if (day === null) {
                        return <div key={`empty-${index}`} className="date-picker-day empty" />;
                    }
                    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                    const isToday = dateStr === todayStr;
                    const isSelected = dateStr === selectedDateStr;

                    return (
                        <button
                            key={day}
                            className={`date-picker-day ${isToday ? 'is-today' : ''} ${isSelected ? 'is-selected' : ''}`}
                            onClick={() => handleDateClick(day)}
                        >
                            {day}
                        </button>
                    );
                })}
            </div>

            {/* Footer actions */}
            <div className="date-picker-footer">
                <button onClick={handleToday} className="date-picker-action">
                    {t('task.today', '今天')}
                </button>
                {value && (
                    <button onClick={handleClear} className="date-picker-action danger">
                        <X size={14} /> {t('task.clear', '清除')}
                    </button>
                )}
            </div>
        </div>
    );
};

export default DatePicker;
