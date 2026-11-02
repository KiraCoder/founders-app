import { describe, expect, it } from "vitest";
import {
  actDueFrom,
  askLine,
  cellState,
  cellTone,
  contractWarning,
  contractWarningText,
  elmuratMessage,
  expectation,
  graceDays,
  gridMonths,
  monthList,
  netDebts,
  reminderLine,
  totalDebt,
  type FlowTiming,
} from "@/lib/holding";

const flow = (over: Partial<FlowTiming> = {}): FlowTiming => ({ status: "active", since: "2026-03-15", until: null, ...over });

describe("expected months", () => {
  it("nothing before the flow's start month; the start month itself is expected", () => {
    expect(expectation(flow(), "2026-02-01", "2026-11-20", 10)).toBe("before_start");
    expect(expectation(flow(), "2026-03-01", "2026-11-20", 10)).toBe("expected");
  });

  it("the current month is not due; the last month only after the grace days", () => {
    const f = flow();
    expect(expectation(f, "2026-11-01", "2026-11-20", 10)).toBe("not_due");
    expect(expectation(f, "2026-10-01", "2026-11-10", 10)).toBe("not_due");
    expect(expectation(f, "2026-10-01", "2026-11-11", 10)).toBe("expected");
    expect(actDueFrom("2026-10-01", 10)).toBe("2026-11-11");
    expect(actDueFrom("2026-12-01", 10)).toBe("2027-01-11");
    // Grace is configurable (0 = due on the 1st).
    expect(expectation(f, "2026-10-01", "2026-11-01", 0)).toBe("expected");
  });

  it("planned, archived and undated flows expect nothing; months after `until` neither", () => {
    expect(expectation(flow({ status: "planned" }), "2026-05-01", "2026-11-20", 10)).toBe("inactive");
    expect(expectation(flow({ archived: true }), "2026-05-01", "2026-11-20", 10)).toBe("inactive");
    expect(expectation(flow({ since: null }), "2026-05-01", "2026-11-20", 10)).toBe("inactive");
    expect(expectation(flow({ until: "2026-06-30" }), "2026-06-01", "2026-11-20", 10)).toBe("expected");
    expect(expectation(flow({ until: "2026-06-30" }), "2026-07-01", "2026-11-20", 10)).toBe("after_end");
  });

  it("grace days come from HOLDING_ACTS_GRACE_DAYS (bad values fall back to 10)", () => {
    expect(graceDays({})).toBe(10);
    expect(graceDays({ HOLDING_ACTS_GRACE_DAYS: "5" })).toBe(5);
    expect(graceDays({ HOLDING_ACTS_GRACE_DAYS: "-1" })).toBe(10);
    expect(graceDays({ HOLDING_ACTS_GRACE_DAYS: "abc" })).toBe(10);
  });

  it("grid months: the last 12 finished months + the current one, oldest first", () => {
    const m = gridMonths("2026-11-02");
    expect(m).toHaveLength(13);
    expect(m[0]).toBe("2025-11-01");
    expect(m[12]).toBe("2026-11-01");
  });
});

describe("grid cell states", () => {
  it("a recorded status wins; without one, expected = missing, otherwise grey", () => {
    expect(cellState(null, "expected")).toBe("missing");
    expect(cellState("missing", "expected")).toBe("missing");
    expect(cellState("requested", "expected")).toBe("requested");
    expect(cellState("received", "not_due")).toBe("received");
    expect(cellState("not_needed", "expected")).toBe("not_needed");
    expect(cellState(null, "before_start")).toBe("before_start");
    expect(cellState(null, "not_due")).toBe("not_due");
  });

  it("colours: green signed/received, yellow requested, red missing, grey not needed / before start", () => {
    expect(cellTone("signed")).toBe("ok");
    expect(cellTone("received")).toBe("ok");
    expect(cellTone("requested")).toBe("warn");
    expect(cellTone("missing")).toBe("risk");
    expect(cellTone("not_needed")).toBe("grey");
    expect(cellTone("before_start")).toBe("grey");
    expect(cellTone("inactive")).toBe("grey");
    expect(cellTone("not_due")).toBe("upcoming");
  });
});

describe("debts between companies", () => {
  it("nets both directions per pair and drops pairs that net to zero", () => {
    const pairs = netDebts([
      { debtor: "brand", creditor: "style", amount: 1_500_000, date: "2026-09-30" },
      { debtor: "style", creditor: "brand", amount: 260_000, date: "2026-09-30" },
      { debtor: "brand", creditor: "style", amount: -0.01, date: "2026-10-05" },
      { debtor: "kiwi", creditor: "jobutify", amount: 100, date: "2026-10-01" },
      { debtor: "kiwi", creditor: "jobutify", amount: -100, date: "2026-10-02" },
    ]);
    expect(pairs).toEqual([{ debtor: "brand", creditor: "style", amount: 1_239_999.99 }]);
    expect(totalDebt(pairs)).toBe(1_239_999.99);
  });

  it("the other direction wins when it is larger; asOf ignores later movements", () => {
    const moves = [
      { debtor: "a", creditor: "b", amount: 100, date: "2026-09-01" },
      { debtor: "b", creditor: "a", amount: 300, date: "2026-10-15" },
    ];
    expect(netDebts(moves)).toEqual([{ debtor: "b", creditor: "a", amount: 200 }]);
    expect(netDebts(moves, "2026-09-30")).toEqual([{ debtor: "a", creditor: "b", amount: 100 }]);
  });

  it("sums cents exactly (no float drift)", () => {
    const moves = Array.from({ length: 10 }, () => ({ debtor: "a", creditor: "b", amount: 0.1, date: "2026-01-01" }));
    expect(netDebts(moves)[0]!.amount).toBe(1);
  });
});

describe("contract expiry warnings", () => {
  it("signed contracts ending within 30 days warn; ended ones are overdue; others never", () => {
    const today = "2026-11-02";
    expect(contractWarning({ status: "signed", validUntil: "2026-12-02" }, today)).toEqual({ kind: "expiring", days: 30 });
    expect(contractWarning({ status: "signed", validUntil: "2026-12-03" }, today)).toBeNull();
    expect(contractWarning({ status: "signed", validUntil: "2026-11-02" }, today)).toEqual({ kind: "expiring", days: 0 });
    expect(contractWarning({ status: "signed", validUntil: "2026-10-30" }, today)).toEqual({ kind: "overdue", days: 3 });
    expect(contractWarning({ status: "draft", validUntil: "2026-11-10" }, today)).toBeNull();
    expect(contractWarning({ status: "expired", validUntil: "2026-10-01" }, today)).toBeNull();
    expect(contractWarning({ status: "signed", validUntil: null }, today)).toBeNull();
    expect(contractWarningText({ kind: "expiring", days: 1 })).toBe("Ends in 1 day");
    expect(contractWarningText({ kind: "overdue", days: 3 })).toContain("Ended 3 days ago");
  });
});

describe("asking Elmurat", () => {
  const groups = [
    { label: "Alura Style → Alura Brand", service: "пошив", months: ["2026-10-01", "2026-09-01"] },
    { label: "Jobutify → Kiwi Go", service: "приложение", months: ["2026-10-01"] },
  ];

  it("one grouped line with the count and months per flow", () => {
    expect(askLine(groups, "2026-11-11")).toBe(
      "Ask Elmurat for 3 missing акты: Alura Style → Alura Brand (Sep, Oct), Jobutify → Kiwi Go (Oct)",
    );
    expect(askLine([{ ...groups[1]! }], "2026-11-11")).toBe("Ask Elmurat for 1 missing акт: Jobutify → Kiwi Go (Oct)");
    const many = Array.from({ length: 5 }, (_, i) => ({ label: `F${i}`, service: "", months: ["2025-12-01"] }));
    expect(askLine(many, "2026-01-11")).toBe("Ask Elmurat for 5 missing акты: F0 (Dec 25), F1 (Dec 25), F2 (Dec 25) +2 more");
    expect(reminderLine(groups, "2026-11-23", "2026-11-11")).toBe(
      "Still waiting for 3 акты from Elmurat (asked 11 Nov): Alura Style → Alura Brand (Sep, Oct), Jobutify → Kiwi Go (Oct)",
    );
  });

  it("runs of 3+ months are shown as a range", () => {
    const m = ["2026-01-01", "2026-02-01", "2026-03-01", "2026-05-01", "2026-06-01", "2026-08-01", "2026-09-01", "2026-10-01"];
    expect(monthList(m, "2026-11-11")).toBe("Jan–Mar, May, Jun, Aug–Oct");
    expect(monthList(["2025-11-01", "2025-12-01", "2026-01-01"], "2026-02-11")).toBe("Nov 25–Jan");
  });

  it("the copyable message is in Russian and lists months per flow", () => {
    expect(elmuratMessage(groups)).toBe(
      [
        "Элмурат, здравствуйте!",
        "Пришлите, пожалуйста, акты приёма-передачи за:",
        "— Alura Style → Alura Brand (пошив): сентябрь, октябрь 2026",
        "— Jobutify → Kiwi Go (приложение): октябрь 2026",
        "Спасибо!",
      ].join("\n"),
    );
    expect(elmuratMessage([{ label: "A → B", service: "", months: ["2026-01-01", "2025-12-01"] }])).toContain(
      "— A → B: декабрь 2025; январь 2026",
    );
    expect(elmuratMessage([])).toBe("");
  });
});
