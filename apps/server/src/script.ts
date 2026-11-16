/**
 * The "script" runtime: a fixed playbook through the real board tools, with
 * no model. For tests and the browser checks only (FOUNDATION_AGENT_SCRIPT=1),
 * so the crew can be checked end to end (names, cursors, aim-then-act,
 * helpers, bring_view, attribution) without a subscription or credits, and
 * the same way every time. It never runs in a real deployment.
 *
 * The lead's playbook, for an ask like “make a section called “Supply” with
 * the parts and hook up FactoryForm, and get help”:
 *   plan → read the board → section → table of parts → (connector) →
 *   (a helper writes a note) → a note → arrange → bring the person there.
 * A helper reads what its crew has made (crew_work: the lead's plan, each
 * agent's cards) and writes one note in the section it was given: the
 * supplier list, or, when a teammate already wrote that, only the lead times.
 * "…get two helpers" calls in a second one, after the first has written.
 */

import type { AgentEvent } from "@foundation/protocol";
import { runTool, type ToolCtx } from "./tools.ts";
import { crewMember, crewWork } from "./crew.ts";

type CrewWork = ReturnType<typeof crewWork>;

function stepMs() {
  const v = Number(process.env.FOUNDATION_SCRIPT_STEP_MS ?? "300");
  return Number.isFinite(v) && v >= 0 ? v : 300;
}

const quoted = (s: string) => /[“"]([^”"]{1,60})[”"]/.exec(s)?.[1]?.trim();

export async function runScript(opts: { prompt: string; signal: AbortSignal; persona?: "shiba" }, emit: (e: AgentEvent) => void, ctx: ToolCtx) {
  const wait = () => new Promise((r) => setTimeout(r, stepMs()));
  const step = async (name: string, input: Record<string, unknown>) => {
    if (opts.signal.aborted) throw new Error("stopped");
    emit({ type: "status", status: "working" });
    emit({ type: "tool", name, input });
    try {
      const out = await runTool(ctx, name, input);
      const text = typeof out === "string" ? out : JSON.stringify(out);
      emit({ type: "tool_result", name, ok: true, summary: text.slice(0, 200) });
      await wait();
      return out as Record<string, unknown> | string;
    } catch (e) {
      emit({ type: "tool_result", name, ok: false, summary: (e as Error).message });
      throw e;
    }
  };
  emit({ type: "status", status: "thinking" });

  // the Shiba on Today: read the person's day, point at what's first, and say it
  if (opts.persona === "shiba") {
    const day = (await step("today", {})) as { focus: Array<{ id: string; title: string; why: string }>; goals: Array<{ id: string; title: string; status: string }> };
    const first = day.focus[0];
    const goal = day.goals.find((g) => g.status === "active");
    const ids = [first?.id, goal?.id].filter((x): x is string => !!x);
    if (ids.length) await step("point_today", { ids });
    emit({
      type: "text",
      text: first ? `Start with “${first.title}”: ${first.why.charAt(0).toLowerCase()}${first.why.slice(1)}.${goal ? ` It moves “${goal.title}” along.` : ""}` : "Nothing is waiting on you today.",
    });
    emit({ type: "done", runtime: "script" });
    return;
  }

  // a helper: it reads what the crew has made (and the lead's plan), then writes one note where it was sent,
  // or, when a teammate already wrote the supplier list, only the part that isn't there yet
  const helperSection = /\(Work in the section “([^”]+)”\.\)/.exec(opts.prompt)?.[1];
  if (/^You were called in by /.test(opts.prompt)) {
    const section = helperSection ?? "Workspace";
    const work = (await step("crew_work", {})) as CrewWork | string;
    const crew = typeof work === "string" ? null : work;
    const theirs = (crew?.crew ?? []).filter((c) => c.name !== crew?.you).flatMap((c) => c.made.map((x) => ({ ...x, by: c.name })));
    const already = theirs.find((x) => x.name === "Suppliers to call");
    const forPlan = crew?.plan ? `For ${crew.lead}'s plan: ${crew.plan.goal}.` : "";
    const note = (
      already
        ? await step("add_note", { section, title: "Lead times", markdown: `- Kapaʻa Metals: 3 weeks\n- Pacific Fasteners: on stock\n\n*${already.by} already wrote “Suppliers to call”, so this is only the lead times. ${forPlan}*` })
        : await step("add_note", { section, title: "Suppliers to call", markdown: `- Kapaʻa Metals: lead time 3 weeks\n- Pacific Fasteners: on stock\n\n*Written by a helper the lead called in. ${forPlan}*` })
    ) as { id: string };
    await step("focus", { object_id: note.id, note: already ? "the lead times" : "the supplier list" });
    emit({ type: "text", text: already ? `${already.by} already wrote the supplier list, so I added only the lead times.` : "Wrote the supplier list." });
    emit({ type: "done", runtime: "script" });
    return;
  }

  // keeping a Slack section (slacklive.ts's brief): read the channel, rewrite the summary, name a picture, put things in order
  const slack = /^Keep the section “#([^”]+)” \(section id (\S+)\) on this board current with its Slack channel \(channel id (\S+)\)/.exec(opts.prompt);
  if (slack) {
    const [, name, sectionId, channel] = slack;
    const summary = /note “Summary” \(card id (\S+)\)/.exec(opts.prompt)?.[1];
    const latest = /then Latest \((\S+)\)/.exec(opts.prompt)?.[1];
    const cards = [...opts.prompt.matchAll(/(media_\w+) \(“/g)].map((m) => m[1]);
    const read = String(await step("slack_read", { channel, limit: 60 }));
    const lines = read.split("\n").filter((l) => l.startsWith("["));
    const said = lines.slice(-3).map((l) => `- ${l.replace(/^\[[^\]]+\]\s*/, "")}`);
    if (summary) await step("update_card", { id: summary, markdown: `## #${name}\n\nWhat's going on, from the channel:\n\n${said.join("\n") || "- nothing yet"}\n\n*Written from the last ${lines.length} messages.*` });
    if (cards[0]) await step("update_card", { id: cards[0], name: `Newest from #${name}` });
    await step("arrange_section", { section: sectionId, order: [summary, latest, ...cards].filter(Boolean) });
    emit({ type: "text", text: `Rewrote the summary of #${name} from ${lines.length} messages and put ${cards.length} image${cards.length === 1 ? "" : "s"} in order.` });
    emit({ type: "done", runtime: "script" });
    return;
  }

  // using a machine's desktop (machinedesktop.ts): look, open the file manager from the desktop's Home icon,
  // go to the machine's pipes folder by keyboard, and say so. Without a person's leave the first step says why, and that's the answer.
  const desk = /\bdesktop of “([^”]+)”/.exec(opts.prompt)?.[1];
  if (desk) {
    try {
      await step("desktop_screenshot", { machine: desk });
      await step("desktop_mouse", { machine: desk, action: "double_click", x: 69, y: 180 });
      await step("desktop_key", { machine: desk, keys: ["ctrl+l"] });
      await step("desktop_type", { machine: desk, text: "/foundation\n" });
      emit({ type: "text", text: `Opened the file manager on ${desk}'s desktop and went to /foundation, where its pipes are.` });
    } catch (e) {
      emit({ type: "text", text: `I couldn't use ${desk}'s desktop: ${(e as Error).message}` });
    }
    emit({ type: "done", runtime: "script" });
    return;
  }

  const section = quoted(opts.prompt) ?? "Supply chain";
  await step("set_plan", {
    goal: `${section}: the parts on the board, with their data`,
    steps: [
      { text: "Make the section", status: "active" },
      { text: "Put the parts in a table", status: "pending" },
      { text: "Show you", status: "pending" },
    ],
  });
  await step("read_board", {});
  await step("add_section", { name: section });
  const table = (await step("add_table", {
    section,
    name: "Parts",
    columns: ["Part", "Qty", "Supplier", "Unit $"],
    rows: [
      ["Vane, 6061", 12, "Kapaʻa Metals", 38.5],
      ["Hub bearing", 2, "Pacific Fasteners", 14],
      ["M4 cap screw", 48, "Pacific Fasteners", 0.12],
      ["Total", "", "", "=SUM(D2:D4)"],
    ],
  })) as { id: string };
  // asked to point things out: the cursor shows the total, then the cheapest part
  if (/\bpoint|\btotal\b/i.test(opts.prompt)) {
    await step("point_at", { target: table.id, cell: "D5", note: "the total, 52.62" });
    await step("point_at", { target: table.id, cell: "A4", note: "the cheapest part" });
  }
  if (/factory|data source|hook/i.test(opts.prompt)) {
    await step("add_panel", { section, panel: "connector", name: "FactoryForm", connector: "factoryform", text: "the floor, live" });
  }
  if (/\bhelp|crew|together\b/i.test(opts.prompt)) {
    await step("call_in_help", { task: "Write the list of suppliers to call for these parts.", section });
    // two helpers: the second part overlaps the first, so its helper has to see what the first one made
    if (/\btwo helpers\b/i.test(opts.prompt)) {
      const me = crewMember(ctx.crew);
      for (let i = 0; i < 100 && me && !crewWork(me).crew.some((c) => c.role === "helper" && c.made.length); i++) await new Promise((r) => setTimeout(r, 100));
      await step("call_in_help", { task: "Write the suppliers to call for these parts, with their lead times.", section });
    }
  }
  await step("add_note", { section, title: "What's here", markdown: `## ${section}\n\nThe parts and what they cost, made by the crew.` });
  await step("set_plan", {
    goal: `${section}: the parts on the board, with their data`,
    steps: [
      { text: "Make the section", status: "done" },
      { text: "Put the parts in a table", status: "done" },
      { text: "Show you", status: "active" },
    ],
  });
  await step("arrange_section", { section });
  await step("bring_view", { target: section, note: "the parts table is ready" });
  emit({ type: "text", text: `Made “${section}” with a parts table${/factory|hook/i.test(opts.prompt) ? " and FactoryForm hooked up" : ""}, and brought you there.` });
  emit({ type: "done", runtime: "script" });
}
