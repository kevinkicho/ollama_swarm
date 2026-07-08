import {
  FormattedTipContent,
  TipKvRow,
  type TipKvField,
} from "./FormattedTipContent";
import {
  buildRecentRunTipFields,
  recentRunChipLabel,
  type RecentRun,
} from "./RecentRuns";

export function RecentRunTipContent({ run }: { run: RecentRun }) {
  const { primary, preset } = recentRunChipLabel(run);
  const fields = buildRecentRunTipFields(run);
  const title = preset ? (
    <>
      {primary}
      <span className="text-ink-500 font-normal ml-1.5">{preset}</span>
    </>
  ) : (
    primary
  );

  return (
    <FormattedTipContent title={title} footer="Click chip to refill the form">
      {fields.map((field: TipKvField) => (
        <TipKvRow key={field.label} field={field} />
      ))}
    </FormattedTipContent>
  );
}