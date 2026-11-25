# Flows: how data moves card to card

2026-11-24. Josh: "test whether disconnecting or connecting actually makes a difference in the flow of information, inform the architecture that is wiring this up."

## What was true before this

A wire (`LinkDoc` in the board's `links` map) joined two ports. Only some ends carried anything.

| Source | Did it put a value on its port? |
|---|---|
| An app in a frame | Yes. Its `foundation:output` postMessage set `outputs[port]` (PanelView's bridge). |
| An agent | Yes, through `send_to_port` and `call_app_tool … to_port`. |
| A machine | Yes. `machineio.ts` polls `/foundation/out`. |
| A pipeline stage, Hermes | Yes, on completion or on an answer. |
| **A connector (BomForm, FactoryForm, Vision, Data Room, Creation)** | **No.** It showed its system's numbers on its card, but nothing wrote its `outputs`. |

| Target | Did it take the value? |
|---|---|
| An app | Yes. The client reads `inputValue` and posts `foundation:input` into the frame. |
| A machine | Yes. Written to `/foundation/in`. |
| A note or table | Only from a machine. `connect` refused any other source. |
| Collections and Foundation's avatars | Yes, by their own server observers. |

So the Form Industries grid's seeded wires (BomForm → FactoryForm, BomForm → Data Room, …) carried nothing, and connecting or disconnecting one changed nothing anywhere.

## What it is now

```
 connector card ──out──▶ table (rows) ──sourceTableId──▶ map
   │ read by the server    │ filled by the server         │ pins from Lat/Lng
   │ only while wired       │ through the table's lens     │ (client, live)
   ▼                        ▼
 outputs.out =            cells = recordsToRows(applyLens(value, table.feed))
 { from, summary,         flows[table] = { status, rows, total, from, error }
   at, rows[] }
```

- **A wire is the only thing that moves data.** With no wire, nothing is copied and no system is read.
- **Connectors emit while wired** (`apps/server/src/flows.ts` `feedConnectors`). A connector card with a wire out of it is read when the wire is made, and every 60 s while it stays wired. The connector cache (`readConnector`, TTL) keeps that to one read per system however many boards wire it. Its main list (the first list of records the system answers: BomForm's cert programs, FactoryForm's stations) goes on its out port as `{ from, summary, at, rows }`.
- **Tables take a wire** into port `rows` (`TABLE_PORT`). The server writes what arrives into the table's cells through the table's lens, `TableDoc.feed`:
  - `filter`: clauses like `itemsOpen > 0; stage ~ test`
  - `columns`: by name, ignoring case and spaces
  - `limit`
  
  The lens is pure and shared: `packages/protocol/src/flows.ts` `applyLens`. A table fed by a table follows it in the same pass.
- **Disconnecting stops the flow.** The table keeps its last rows, its flow state turns `unfed`, the bar on the table says so, and the connector is no longer read. Putting the wire back (a person's ⌘Z, since a wire is an ordinary change in the grid's undo stack) refills the table with what the source says now.
- **State is real and the server's own.** `flows[tableId]` is a server-only board map:
  - `working`: the source is being read
  - `waiting`: wired, and nothing has arrived
  - `ok`: with rows and total
  - `error`: with why (a lens it can't read, or "BomForm is offline — …")
  - `unfed`
  
  Its writes carry the `flows` origin, so no person's undo takes them back and they don't wake the observer.
- **What people see** (client):
  - **The wire's chip**: a peek at the value, or the far card's state from `flows`, a character stage's progress, or a card's `running`/`error` status (`shell/flowWork.ts`). Nothing is shown as "loading" without a real state behind it.
  - **The port's card**: a sample of the value (`shell/flowPeek.tsx`).
  - **The wire's bar**: the sample and Disconnect.
  - **The fed table's lens bar** (`components/TableFeed.tsx`).

## Invariants this keeps

- Reading a connector is reading company data the server already reads for the connector card. Nothing new leaves Foundation, nothing spends money, nothing third-party runs.
- Writes name their board. Agents' `disconnect` needs `confirm: true`. Viewers can't write a wire or a lens (both are ordinary board writes).
- The server never rewrites a table nobody wired: only tables with a wire into `rows` are filled.
- `flows` is one of `SERVER_MAPS` (boards.ts): a change to it from a person's socket is put back, so nobody can fake a table's state.
- A connector is read only for a wire into something that reads (a table, an app, a machine). The company map's seeded connector-to-connector wires read nothing.

## Tested

- `apps/server/test/flows.test.ts` (10 cases):
  - an unwired connector isn't read
  - a wire fills the table through the lens
  - upstream changes flow while wired
  - disconnecting stops them and the connector isn't read
  - re-wiring refills
  - table → table
  - a lens it can't read
  - an offline system, then back online
  - the examples
  - `disconnect` needs confirm
- `apps/client/e2e/flows.spec.ts` (6, a real browser):
  - the port card on top
  - drag a wire onto a table, then set the lens
  - press the wire, Disconnect, emit again (nothing arrives), ⌘Z (it refills), redo
  - the examples with FactoryForm's real stations and BomForm's offline reason
  - day shots
  - `#/design`
  
  Evidence is in `docs/evidence/2026-11-24_flows/`.

## Not yet

- **A prompt as a lens.** "Pull out what matters from BomForm" in words would be a model call, and a model call spends money. So it has to run when a person presses it, never on every change, and its answer is written like the filter's. The filter lens is the deterministic half.
- **Prompt → 3D character.** A note or text output wired into a character card's identity, with each paid stage still pressed by a person (`requirePerson` on the stage route). The chip already shows a character's stage generating with its progress.
- **Connectors with more than one list.** BomForm also has critical parts and costs. A connector could offer a port per list, where today it offers its main one.
- **Apps' inputs are still client-delivered.** A frame gets `foundation:input` only while someone has the board open. That's unchanged.
