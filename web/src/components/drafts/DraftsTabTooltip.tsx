import type { ReactNode } from "react";
import type { TranscriptEntry } from "../../types";
import { InfoTip } from "../setup/InfoTip";
import {
  FormattedTipContent,
  TipCompactTable,
  TipFigure,
  TipSection,
  type TipTableRow,
} from "../setup/FormattedTipContent";
import { aggregateCouncilCycles } from "./councilCycleAggregate";

/** One-line cycle pipeline (figure). */
export const CYCLE_FLOW_FIGURE = [
  "plan → synth → todos → audit",
  "  ↑ skip plan when todos pending",
] as const;

/** Static reference: planning shape per cycle number. */
export const CYCLE_PLANNING_ROWS: readonly TipTableRow[] = [
  { cells: ["1", "3 debate", "R1 hidden"] },
  { cells: ["2+", "1 standup", "per agent"] },
  { cells: ["drain", "—", "exec only"] },
];

export function formatCouncilRunMode(rounds: number | undefined): string {
  if (rounds === 0) return "∞ until stop";
  if (rounds != null && rounds > 0) return `${rounds} cycle${rounds === 1 ? "" : "s"}`;
  return "default";
}

export function formatCyclePlanningLabel(cycle: number): string {
  if (cycle === 1) return "3 debate";
  return "1 standup";
}

/** cfg.rounds reference rows; highlights the active setting. */
export function buildRoundsConfigRows(rounds: number | undefined): TipTableRow[] {
  const accent =
    rounds === 0 ? "text-emerald-300" : rounds != null && rounds > 0 ? "text-ink-200" : undefined;
  return [
    {
      cells: ["0", "autonomous — repeat until done/stop"],
      accent: rounds === 0 ? accent : undefined,
      highlight: rounds === 0,
    },
    {
      cells: ["N", "run N full cycles, then exit"],
      accent: rounds != null && rounds > 0 ? accent : undefined,
      highlight: rounds != null && rounds > 0,
    },
    { cells: ["≠", "not the 3 debate rounds in cycle 1"] },
  ];
}

/** Label/value rows for the live run section (this run table). */
export function buildDraftsTabLiveRows(
  rounds: number | undefined,
  cycles: ReturnType<typeof aggregateCouncilCycles>,
): TipTableRow[] {
  const rows: TipTableRow[] = [
    {
      cells: ["mode", formatCouncilRunMode(rounds)],
      accent: rounds === 0 ? "text-emerald-300" : "text-ink-200",
    },
    {
      cells: ["cfg.rounds", rounds === 0 ? "0" : String(rounds ?? "—")],
    },
  ];

  if (cycles.length > 0) {
    const latest = cycles[cycles.length - 1]!;
    rows.push(
      { cells: ["cycles", String(cycles.length)] },
      {
        cells: [
          "current",
          latest.isDrainOnly ? `#${latest.cycle} drain` : `#${latest.cycle}`,
        ],
      },
      {
        cells: [
          "planning",
          latest.isDrainOnly ? "skipped" : formatCyclePlanningLabel(latest.cycle),
        ],
      },
    );
  }

  return rows;
}

export function DraftsTabTipContent({
  rounds,
  transcript,
  footer,
}: {
  rounds: number | undefined;
  transcript: readonly TranscriptEntry[];
  footer?: ReactNode;
}) {
  const cycles = aggregateCouncilCycles([...transcript]);
  const liveRows = buildDraftsTabLiveRows(rounds, cycles);

  return (
    <FormattedTipContent title="Council cycles & rounds" footer={footer}>
      <TipFigure lines={CYCLE_FLOW_FIGURE} />
      <TipSection label="planning by cycle" divider>
        <TipCompactTable
          headers={["Cycle", "Rounds", "Notes"]}
          rows={CYCLE_PLANNING_ROWS}
          bordered
          colWidths={["w-12", "", "w-[34%]"]}
          colAlign={["center", "left", "right"]}
        />
      </TipSection>
      <TipSection label="cfg.rounds" divider>
        <TipCompactTable
          headers={["Val", "Behavior"]}
          rows={buildRoundsConfigRows(rounds)}
          bordered
          colWidths={["w-10", ""]}
          colAlign={["center", "left"]}
        />
      </TipSection>
      {cycles.length > 0 ? (
        <TipSection label="this run" divider accent="emerald">
          <TipCompactTable
            headers={["", ""]}
            rows={liveRows}
            hideHeader
            bordered
            variant="kv"
            colWidths={["w-[42%]", ""]}
          />
        </TipSection>
      ) : null}
    </FormattedTipContent>
  );
}

const TAB_BUTTON_CLASS =
  "px-4 py-2 border-b-2 transition-colors cursor-default";

export function DraftsTabWithTooltip({
  active,
  onClick,
  rounds,
  transcript,
}: {
  active: boolean;
  onClick: () => void;
  rounds: number | undefined;
  transcript: readonly TranscriptEntry[];
}) {
  return (
    <InfoTip
      maxWidth={400}
      wrapperClassName="inline-block"
      trigger={
        <button
          type="button"
          onClick={onClick}
          className={
            TAB_BUTTON_CLASS +
            (active
              ? " border-emerald-500 text-emerald-300"
              : " border-transparent text-ink-400 hover:text-ink-200")
          }
        >
          Drafts
        </button>
      }
    >
      <DraftsTabTipContent rounds={rounds} transcript={transcript} />
    </InfoTip>
  );
}