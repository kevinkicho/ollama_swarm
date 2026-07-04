// BrainProposalsPanel / BrainInsightsPanel has been removed.
//
// Per requirements: the Brain layer no longer maintains infrastructure for
// reviewing system code or exposing "insights/proposals" about the platform.
//
// - Regular AI agents (via presets/directives) can still be asked to review code
//   when the user wants that.
// - Brain is strictly librarian/master-admin for:
//     • initializing app
//     • starting a run
//     • finishing a run
//     • reviewing run records
//     • providing final run analysis
//
// Analysis may still happen server-side for run records, but there is no
// dedicated UI panel for brain-generated "proposals" or "insights".
export function BrainProposalsPanel() {
  return null;
}
