import type { CalendarWeekStart } from '../store'

/**
 * Best-effort first weekday from the user's locale, as 0 (Sunday) .. 6
 * (Saturday). Falls back to Monday (1) when `Intl.Locale` weekInfo isn't
 * available.
 */
export function localeFirstDay(): number {
  try {
    const loc = new Intl.Locale(navigator.language) as unknown as {
      weekInfo?: { firstDay?: number }
      getWeekInfo?: () => { firstDay?: number }
    }
    const info = loc.weekInfo ?? loc.getWeekInfo?.()
    if (info && typeof info.firstDay === 'number') return info.firstDay % 7 // 7(Sun)->0
  } catch {
    /* ignore */
  }
  return 1
}

/**
 * Resolve the `calendarWeekStart` preference to a 0 (Sunday) .. 6 index for
 * building month grids and rotating weekday labels. Shared by the sidepanel
 * calendar and the Tasks calendar so both honor the setting (#300).
 */
export function resolveWeekStartDay(weekStart: CalendarWeekStart): number {
  return weekStart === 'sunday' ? 0 : weekStart === 'locale' ? localeFirstDay() : 1
}
