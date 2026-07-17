import { reportScheduleFrequencyLabel } from './report-schedule-presentation.ts';
import type { PrivateReportRecurrenceV1 } from './report-schema.ts';

const recurrenceLists = [
  { field: 'increments', label: '増加・新規' },
  { field: 'decrements', label: '減少・解消' },
  { field: 'continued_items', label: '継続事項' },
] as const;

/**
 * Renders the bounded, redacted delta from a report's previous scheduled occurrence.
 *
 * @param recurrence - Trusted recurrence data embedded in the report JSON
 * @param publicView - Whether to expose public-view test identifiers
 */
export function ReportRecurrencePanel({
  publicView = false,
  recurrence,
}: {
  readonly publicView?: boolean;
  readonly recurrence: PrivateReportRecurrenceV1;
}) {
  const testIdPrefix = publicView ? 'public-report-recurrence' : 'report-recurrence';

  return (
    <section className="report-recurrence-panel" data-testid={testIdPrefix}>
      <div className="report-recurrence-heading">
        <div>
          <p className="eyebrow">前回の定期レポートとの差分</p>
          <h3>今回の変化</h3>
        </div>
        <span className="report-generation-badge" data-testid={`${testIdPrefix}-frequency`}>
          {reportScheduleFrequencyLabel(recurrence.frequency)}
        </span>
      </div>
      <p data-testid={`${testIdPrefix}-summary`}>{recurrence.change_summary}</p>
      <div className="report-recurrence-groups">
        {recurrenceLists.map(({ field, label }) => {
          const items = recurrence[field];
          return items.length > 0 ? (
            <section data-testid={`${testIdPrefix}-${field}`} key={field}>
              <h4>{label}</h4>
              <ul>
                {items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </section>
          ) : null;
        })}
      </div>
    </section>
  );
}
