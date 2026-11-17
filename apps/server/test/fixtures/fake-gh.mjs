#!/usr/bin/env node
// A stand-in for `gh api`, for the plan sync tests: issues, labels and
// milestones live in a JSON file (FAKE_GH_STATE), and every write is logged
// there so a test can see what reached "GitHub".
import { readFileSync, writeFileSync } from "node:fs";

const file = process.env.FAKE_GH_STATE;
const state = JSON.parse(readFileSync(file, "utf8"));
state.calls ??= [];
const args = process.argv.slice(2);
if (args[0] !== "api") {
  console.error(`fake gh: only api (got ${args.join(" ")})`);
  process.exit(2);
}
const method = args.includes("-X") ? args[args.indexOf("-X") + 1] : "GET";
const path = args.filter((a) => !a.startsWith("-") && a !== "api" && a !== method).at(-1).replace(/^\//, "");
const body = args.includes("--input") ? JSON.parse(readFileSync(0, "utf8") || "null") : null;
const save = () => writeFileSync(file, JSON.stringify(state, null, 2));
const out = (v) => process.stdout.write(JSON.stringify(v));
const route = path.split("?")[0].split("/").slice(3); // repos/<owner>/<repo>/...

if (method === "GET") {
  const pages = (xs) => out(args.includes("--slurp") ? [xs] : xs);
  if (route[0] === "issues") pages(state.issues);
  else if (route[0] === "labels") pages(state.labels.map((name) => ({ name })));
  else if (route[0] === "milestones") pages(state.milestones);
  else out([]);
} else if (method === "POST" && route[0] === "labels") {
  state.labels.push(body.name);
  save();
  out({ name: body.name });
} else if (method === "POST" && route[0] === "milestones") {
  const m = { title: body.title, number: state.milestones.length + 1 };
  state.milestones.push(m);
  save();
  out(m);
} else if (method === "POST" && route[0] === "issues") {
  const number = Math.max(0, ...state.issues.map((i) => i.number)) + 1;
  const issue = { number, state: "open", title: body.title, body: body.body, labels: body.labels.map((name) => ({ name })), milestone: null };
  state.issues.push(issue);
  state.calls.push({ method, number, body });
  save();
  out(issue);
} else if (method === "PATCH" && route[0] === "issues") {
  const issue = state.issues.find((i) => i.number === Number(route[1]));
  if (body.labels) issue.labels = body.labels.map((name) => ({ name }));
  if (body.state) issue.state = body.state;
  if (body.title) issue.title = body.title;
  state.calls.push({ method, number: issue.number, body });
  save();
  out(issue);
} else {
  console.error(`fake gh: no route for ${method} ${path}`);
  process.exit(3);
}
