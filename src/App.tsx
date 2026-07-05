import { useEffect } from "react";
import { motion } from "motion/react";
import { GridViewport } from "./components/GridViewport";
import {
  addNote,
  createMap,
  createTable,
  getState,
  renameSection,
  requestSnap,
  resizeTable,
  splitSection,
} from "./state/store";
import { workbook } from "./engine/workbook";
import "./App.css";

/** Seed a small demo workspace on first launch so the app opens alive. */
let seeded = false;
function seedDemo() {
  if (seeded) return;
  seeded = true;

  // shape the grid: one column split off, right column split into two rows
  const s1 = Object.keys(getState().sections)[0];
  splitSection(s1, "h");
  const s2 = getState().activeSectionId;
  splitSection(s2, "v");
  const s3 = getState().activeSectionId;
  renameSection(s1, "Projections");
  renameSection(s2, "Team");
  renameSection(s3, "Atlas");

  const t = createTable(s1, 0, 0);
  const put = (col: number, row: number, v: string) =>
    workbook.setCell(t.id, col, row, v);
  put(0, 0, "Market");
  put(1, 0, "Contracted");
  put(2, 0, "Follow-on");
  put(3, 0, "Total");
  put(0, 1, "Kobayashi Group");
  put(1, 1, "1500000");
  put(2, 1, "6500000");
  put(3, 1, "=B2+C2");
  put(0, 2, "AHE Group");
  put(1, 2, "1500000");
  put(2, 2, "3000000");
  put(3, 2, "=B3+C3");
  put(0, 3, "Snow Mass");
  put(1, 3, "750000");
  put(2, 3, "0");
  put(3, 3, "=B4+C4");
  put(0, 4, "Farmy");
  put(1, 4, "150000");
  put(2, 4, "0");
  put(3, 4, "=B5+C5");
  put(0, 5, "Isle Communities");
  put(1, 5, "1500000");
  put(2, 5, "0");
  put(3, 5, "=B6+C6");
  put(0, 7, "Totals");
  put(1, 7, "=SUM(B2:B6)");
  put(2, 7, "=SUM(C2:C6)");
  put(3, 7, "=SUM(D2:D6)");

  const team = createTable(s2, 0, 0);
  const putT = (col: number, row: number, v: string) =>
    workbook.setCell(team.id, col, row, v);
  putT(0, 0, "Name");
  putT(1, 0, "Role");
  putT(2, 0, "Lat");
  putT(3, 0, "Lng");
  const people: [string, string, number, number][] = [
    ["Alina", "Design", 37.7749, -122.4194],
    ["Marcus", "Sales", 40.7128, -74.006],
    ["Yuki", "Engineering", 35.6762, 139.6503],
    ["Priya", "Research", 51.5074, -0.1278],
    ["Tom", "Field Ops", -33.8688, 151.2093],
    ["Noa", "Engineering", 21.3069, -157.8583],
  ];
  people.forEach(([name, role, lat, lng], i) => {
    putT(0, i + 1, name);
    putT(1, i + 1, role);
    putT(2, i + 1, String(lat));
    putT(3, i + 1, String(lng));
  });

  // a cross-table formula, so the data-flow wire shows on launch
  resizeTable(t.id, 4, 9);
  put(0, 8, "Team size");
  put(1, 8, `=COUNTA('${team.name}'!A2:A7)`);

  // map in the Atlas section, bound to the Team table
  createMap(s3, 0, 0);

  addNote(
    s2,
    "## Team notes\n\nEveryone below is plotted on the **Atlas** map — edit a `Lat`/`Lng` cell and the pin moves.\n\n- drag any card's header to float it\n- ⌗ docks it back into the flow\n- drop images or videos anywhere in a section",
  );

  requestSnap({ kind: "all" });
}

function App() {
  useEffect(() => {
    seedDemo();
  }, []);

  return (
    <div className="app">
      <motion.header
        className="app-bar"
        initial={{ y: -48, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ type: "spring", stiffness: 190, damping: 22 }}
      >
        <div className="logo">✳</div>
        <div className="app-title">Foundation</div>
        <div className="app-hint">
          drag the void to pan — the view snaps to sections · ctrl+scroll to
          zoom · scroll inside a section · <b>Esc</b> for overview · <b>=</b>{" "}
          starts a formula
        </div>
      </motion.header>
      <GridViewport />
    </div>
  );
}

export default App;
