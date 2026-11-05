import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SkillInputFields } from "@/components/rail/SkillInputFields";
import type { SkillInputField } from "@/lib/skillRun/inputs";

const f = (over: Partial<SkillInputField>): SkillInputField => ({
  name: "x", label: "X", description: null, type: "string", values: [], required: false, default: null, ...over,
});

const FIELDS = [
  f({ name: "title", label: "Title", type: "string", required: true, description: "Shown on the cover" }),
  f({ name: "notes", label: "Notes", type: "textarea" }),
  f({ name: "count", label: "Count", type: "number" }),
  f({ name: "asOf", label: "As of", type: "date" }),
  f({ name: "audience", label: "Audience", type: "enum", values: ["Board", "Buyer"], default: "Board" }),
];

function setup(values = {}, extra = {}) {
  const onChange = vi.fn();
  const onCommit = vi.fn();
  render(<SkillInputFields fields={FIELDS} values={values} problems={{}} missing={null} disabled={false} onChange={onChange} onCommit={onCommit} {...extra} />);
  return { onChange, onCommit };
}

describe("SkillInputFields", () => {
  it("renders one labelled control per type", () => {
    setup();
    expect(screen.getByLabelText(/^Title/)).toHaveAttribute("type", "text");
    expect(screen.getByLabelText("Notes").tagName).toBe("TEXTAREA");
    expect(screen.getByLabelText("Count")).toHaveAttribute("type", "number");
    expect(screen.getByLabelText("As of")).toHaveAttribute("type", "date");
    expect(screen.getByLabelText("Audience").tagName).toBe("SELECT");
  });

  it("marks required fields and links helper text", () => {
    setup();
    const title = screen.getByLabelText(/^Title/);
    expect(title).toHaveAttribute("aria-required", "true");
    expect(title.getAttribute("aria-describedby")).toContain("skill-input-title-help");
    expect(screen.getByText("Shown on the cover")).toHaveAttribute("id", "skill-input-title-help");
  });

  it("preselects the declared default for a choice", () => {
    setup();
    expect(screen.getByLabelText("Audience")).toHaveValue("Board");
  });

  it("sends numbers as numbers and drops an empty number", () => {
    const { onChange } = setup({ count: 3 });
    fireEvent.change(screen.getByLabelText("Count"), { target: { value: "12" } });
    expect(onChange).toHaveBeenLastCalledWith({ count: 12 });
    fireEvent.change(screen.getByLabelText("Count"), { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith({});
  });

  it("commits the whole object on blur", () => {
    const { onCommit } = setup({ title: "Q3", count: 2 });
    fireEvent.blur(screen.getByLabelText(/^Title/));
    expect(onCommit).toHaveBeenCalledWith({ title: "Q3", count: 2 });
  });

  it("shows a field's problem and links it", () => {
    setup({}, { problems: { asOf: "expected a date" } });
    const asOf = screen.getByLabelText("As of");
    expect(asOf).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("expected a date")).toHaveAttribute("id", "skill-input-asOf-error");
    expect(asOf.getAttribute("aria-describedby")).toContain("skill-input-asOf-error");
  });

  it("names the missing required field", () => {
    setup({}, { missing: "title" });
    expect(screen.getByText("Title is required.")).toBeInTheDocument();
  });

  it("renders nothing when there are no fields", () => {
    const { container } = render(<SkillInputFields fields={[]} values={{}} problems={{}} missing={null} disabled={false} onChange={() => undefined} onCommit={() => undefined} />);
    expect(container).toBeEmptyDOMElement();
  });
});
