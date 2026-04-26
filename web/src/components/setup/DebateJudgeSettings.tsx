import { Field } from "./SharedFields";

export function DebateJudgeAdvanced({
  proposition,
  setProposition,
}: {
  proposition: string;
  setProposition: (p: string) => void;
}) {
  return (
    <Field
      label="Proposition"
      hint="The claim PRO argues for and CON argues against. Leave empty for the built-in default (“This project is ready for production use”). Max 2000 chars."
    >
      <textarea
        value={proposition}
        onChange={(e) => setProposition(e.target.value.slice(0, 2000))}
        placeholder="This project is ready for production use"
        rows={2}
        className="input"
        style={{ fontFamily: "inherit", resize: "vertical", minHeight: 44 }}
      />
    </Field>
  );
}
