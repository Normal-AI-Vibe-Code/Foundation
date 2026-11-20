import { useEffect, useRef, useState } from "react";
import type { LocalVmState } from "@foundation/protocol";
import type { PanelMeta } from "../state/store";
import { useUi } from "../state/ui";
import { activeBoard } from "../sync/board";
import { api } from "../lib/api";
import { DesktopScreen } from "./MachineViewDesktop";
import { useOnScreen } from "./PanelView";
import { toggleFullscreen } from "../lib/cardUse";
import { DesktopGlyph, TerminalGlyph } from "../shell/glyphs";
import "./local-vm.css";
interface Iso { id: string; name: string; size: number; sha256: string }
interface Host { available: boolean; note: string; maxMemoryMB: number; maxCpus: number }
interface VmForm { name: string; fileId: string; memoryMB: number; cpus: number; diskGB: number; acceleration: "native" | "software" }
const board = () => encodeURIComponent(activeBoard()?.boardId ?? "company");
const path = (id: string) => `/api/boards/${board()}/vms/${encodeURIComponent(id)}`;
const SETUP = "sudo apt-get update && sudo apt-get install -y qemu-guest-agent && sudo systemctl start qemu-guest-agent";

export function VmSetupView({ files = [], host, busy, error, viewer, onImport, onCreate }: { files?: Iso[]; host?: Host; busy?: string; error?: string; viewer?: boolean; onImport?: (f: File) => void; onCreate?: (f: VmForm) => void }) {
  const [name, setName] = useState("WildOS"), [fileId, setFileId] = useState("");
  const [memoryMB, setMemory] = useState(4096), [cpus, setCpus] = useState(2), [software, setSoftware] = useState(false);
  useEffect(() => { setFileId(files[0]?.id ?? ""); }, [files]);
  useEffect(() => { if (host) { setMemory((m) => Math.min(m, host.maxMemoryMB)); setCpus((n) => Math.min(n, host.maxCpus)); } }, [host]);
  const file = files.find((f) => f.id === fileId) ?? files[0];
  return <form className="vm-setup" onPointerDown={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); if (file) onCreate?.({ name, fileId: file.id, memoryMB, cpus, diskGB: 64, acceleration: software ? "software" : "native" }); }}>
    <div className="vm-intro"><DesktopGlyph size={32} /><div><div className="f-eyebrow">On this computer</div><h3>A full operating system</h3><p>Boot WildOS from an ISO, with its own desktop and a disk that keeps your work.</p></div></div>
    {host && <div className="vm-host"><span className={`f-dot ${host.available ? "is-ok" : "is-warn"}`} />{host.note}{!host.available && <> <a href="https://www.qemu.org/download/#windows" target="_blank" rel="noreferrer">Get QEMU</a></>}</div>}
    <fieldset disabled={Boolean(busy) || viewer}>
      <label>Name<input aria-label="VM name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required /></label>
      <label>Operating system ISO<select aria-label="Operating system ISO" value={file?.id ?? ""} onChange={(e) => setFileId(e.target.value)}><option value="" disabled>Choose or import an ISO</option>{files.map((f) => <option key={f.id} value={f.id}>{f.name} · {(f.size / 1073741824).toFixed(2)} GB</option>)}</select></label>
      <label className="vm-import">Import an ISO from this computer<input aria-label="Import OS ISO" type="file" accept=".iso" onChange={(e) => { const f = e.target.files?.[0]; if (f) onImport?.(f); e.target.value = ""; }} /></label>
      {file && <div className="vm-checksum">Archived · SHA-256 <code>{file.sha256}</code></div>}
      <div className="vm-resources"><label>Memory<select aria-label="VM memory" value={memoryMB} onChange={(e) => setMemory(Number(e.target.value))}>{[1024, 2048, 4096, 8192, 16384].filter((m) => !host || m <= host.maxMemoryMB).map((m) => <option key={m} value={m}>{m / 1024} GB</option>)}</select></label><label>Processors<input aria-label="VM processors" type="number" min={1} max={host?.maxCpus ?? 16} value={cpus} onChange={(e) => setCpus(Number(e.target.value))} /></label><span>64 GB disk<br /><small>Expands as used</small></span></div>
      <label className="vm-check"><input type="checkbox" checked={software} onChange={(e) => setSoftware(e.target.checked)} />Software emulation · slower, works without WSL or a hypervisor</label>
      <div className="vm-note">QEMU runs locally. No host folders are shared. The ISO stays in your archive.</div>
      {!viewer && <button type="submit" className="f-pill is-accent" disabled={!file || Boolean(busy)}>Add VM to this section</button>}
    </fieldset>
    {viewer && <p className="vm-note">View only: an editor adds and controls a VM.</p>}{busy && <div role="status" className="vm-note">{busy}<progress aria-label={busy} /></div>}{error && <div role="alert" className="vm-error">{error}</div>}
  </form>;
}
function VmSetup({ panel }: { panel: PanelMeta }) {
  const viewer = useUi().role === "viewer", requestId = useRef(crypto.randomUUID());
  const [files, setFiles] = useState<Iso[]>([]), [host, setHost] = useState<Host>();
  const [busy, setBusy] = useState<string>(), [error, setError] = useState<string>();
  useEffect(() => { let active = true; Promise.all([api<Host>("/api/vms/host"), api<{ files: Iso[] }>(`/api/boards/${board()}/vm-isos`)]).then(([h, f]) => { if (active) { setHost(h); setFiles(f.files); } }).catch((e) => active && setError(e.message)); return () => { active = false; }; }, []);
  const importIso = async (file: File) => { setBusy(`Archiving ${file.name}…`); setError(undefined); try { const r = await api<{ file: Iso }>(`/api/boards/${board()}/vm-isos?name=${encodeURIComponent(file.name)}`, { method: "POST", body: file, headers: { "content-type": "application/octet-stream" } }); setFiles((old) => [r.file, ...old.filter((f) => f.id !== r.file.id)]); } catch (e) { setError((e as Error).message); } finally { setBusy(undefined); } };
  const create = async (form: VmForm) => { setBusy("Adding the VM…"); setError(undefined); try { await api(`${path(panel.id)}/configure`, { method: "POST", json: { ...form, request_id: requestId.current } }); } catch (e) { setError((e as Error).message); } finally { setBusy(undefined); } };
  return <VmSetupView files={files} host={host} busy={busy} error={error} viewer={viewer} onImport={(f) => void importIso(f)} onCreate={(f) => void create(f)} />;
}
export function VmStatusView({ vm, busy, viewer, error, onAction }: { vm: LocalVmState; busy?: boolean; viewer?: boolean; error?: string; onAction?: (a: string, b?: object) => void }) {
  const live = ["running", "starting", "stopping"].includes(vm.state);
  return <div className="vm-status" onPointerDown={(e) => e.stopPropagation()}><div className="vm-heading"><DesktopGlyph size={19} /><strong>{vm.name}</strong><span className="vm-state"><span className={`f-dot ${vm.state === "running" ? "is-ok" : vm.state === "error" ? "is-bad" : "is-warn"}`} />{vm.state}</span></div><div className="vm-facts"><span>Full OS · QEMU</span><span>{vm.memoryMB / 1024} GB RAM</span><span>{vm.cpus} CPUs</span><span>{vm.diskGB} GB disk</span><span>{vm.acceleration === "software" ? "Software emulation" : "Native acceleration"}</span></div>{vm.detail && <div className="vm-note">{vm.detail}</div>}
    {!viewer && !live && vm.state !== "archived" && <div className="vm-resources-edit"><label>Memory (MB)<input aria-label="VM memory in MB" type="number" min={512} step={512} defaultValue={vm.memoryMB} key={vm.memoryMB} disabled={busy} onBlur={(e) => { if (Number(e.target.value) !== vm.memoryMB) onAction?.("resources", { memoryMB: Number(e.target.value) }); }} /></label><label>CPUs<input aria-label="VM CPU count" type="number" min={1} defaultValue={vm.cpus} key={vm.cpus} disabled={busy} onBlur={(e) => { if (Number(e.target.value) !== vm.cpus) onAction?.("resources", { cpus: Number(e.target.value) }); }} /></label><label className="vm-check"><input type="checkbox" checked={vm.acceleration === "software"} disabled={busy} onChange={(e) => onAction?.("resources", { acceleration: e.target.checked ? "software" : "native" })} />Software emulation</label></div>}
    {!viewer && <div className="vm-actions">{!live && vm.state !== "archived" && <button className="f-pill is-accent" disabled={busy} onClick={() => onAction?.("start")}>Start VM</button>}{vm.state === "running" && <button className="f-pill" disabled={busy} onClick={() => onAction?.("shutdown")}>Shut down</button>}{live && <button className="f-pill" disabled={busy} onClick={() => onAction?.("poweroff")}>Power off…</button>}{!live && vm.state !== "archived" && <label className="vm-check"><input type="checkbox" checked={vm.bootIso} disabled={busy} onChange={(e) => onAction?.("boot", { iso: e.target.checked })} />Boot installer ISO</label>}{!live && <button className="f-pill" disabled={busy} onClick={() => onAction?.(vm.state === "archived" ? "restore" : "archive")}>{vm.state === "archived" ? "Restore VM" : "Archive VM…"}</button>}</div>}{error && <div role="alert" className="vm-error">{error}</div>}
  </div>;
}
function ConfiguredVm({ panel }: { panel: PanelMeta }) {
  const host = useRef<HTMLDivElement>(null), onScreen = useOnScreen(host, 0.25);
  const viewer = useUi().role === "viewer";
  const [vm, setVm] = useState(panel.vm!), [tab, setTab] = useState<"desktop" | "commands">("desktop");
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [confirm, setConfirm] = useState<string>();
  const [keys, setKeys] = useState(false), [command, setCommand] = useState(""), [result, setResult] = useState("");
  const [pid, setPid] = useState<string>();
  const commandRequest = useRef<{ command: string; id: string } | undefined>(undefined);
  useEffect(() => { setVm(panel.vm!); }, [panel.vm]);
  useEffect(() => { if (!onScreen) return; let active = true; const read = () => api<{ vm: LocalVmState }>(path(panel.id)).then((r) => { if (active) setVm(r.vm); }).catch((e) => active && setError(e.message)); void read(); const timer = setInterval(() => void read(), 3000); return () => { active = false; clearInterval(timer); }; }, [panel.id, onScreen]);
  useEffect(() => {
    if (pid === undefined) return;
    let active = true, timer: ReturnType<typeof setTimeout>;
    const read = async () => { try { const r = await api<{ exited: boolean; exitCode: number; signal?: number; stdout: string; stderr: string; truncated: boolean }>(`${path(panel.id)}/commands/${pid}`); if (!active) return; if (!r.exited) { timer = setTimeout(() => void read(), 1000); return; } setPid(undefined); setResult(`${r.stdout}${r.stderr ? `\n${r.stderr}` : ""}\nExit ${r.exitCode ?? `signal ${r.signal}`}${r.truncated ? " · output truncated" : ""}`); } catch (e) { if (active) { setPid(undefined); setResult((e as Error).message); } } };
    void read(); return () => { active = false; clearTimeout(timer); };
  }, [pid, panel.id]);
  const action = async (name: string, body = {}) => { if ((name === "archive" || name === "poweroff") && confirm !== name) { setConfirm(name); return; } setBusy(true); setError(undefined); try { const r = await api<{ vm: LocalVmState }>(`${path(panel.id)}/${name}`, { method: "POST", json: { ...body, ...((name === "archive" || name === "poweroff") ? { confirm: true } : {}) } }); setVm(r.vm); } catch (e) { setError((e as Error).message); } finally { setBusy(false); setConfirm(undefined); } };
  const run = async () => { if (!commandRequest.current || commandRequest.current.command !== command) commandRequest.current = { command, id: crypto.randomUUID() }; setBusy(true); setResult(""); try { const r = await api<{ pid: number; commandId: string }>(`${path(panel.id)}/commands`, { method: "POST", json: { command, request_id: commandRequest.current.id } }); commandRequest.current = undefined; setPid(r.commandId); setResult("Running in the guest…"); } catch (e) { setResult((e as Error).message); } finally { setBusy(false); } };
  const live = vm.state === "running" || vm.state === "stopping";
  return <div ref={host} className="machine-body vm-body"><VmStatusView vm={vm} busy={busy} viewer={viewer} error={error} onAction={(a, b) => void action(a, b)} />
    {confirm && <div className="vm-confirm" onPointerDown={(e) => e.stopPropagation()} role="alert"><span>{confirm === "poweroff" ? "Force power off? Unsaved work can be lost." : "Archive this VM? Its disk and ISO are kept."}</span><button className="f-pill" disabled={busy} onClick={() => void action(confirm)}>Confirm {confirm === "poweroff" ? "power off" : "archive"}</button><button className="f-pill" onClick={() => setConfirm(undefined)}>Cancel</button></div>}
    {live && !viewer && onScreen ? <><div className="vm-tabs" role="tablist" aria-label="VM view"><button role="tab" aria-selected={tab === "desktop"} onClick={() => setTab("desktop")}><DesktopGlyph size={15} />Desktop</button><button role="tab" aria-selected={tab === "commands"} onClick={() => setTab("commands")}><TerminalGlyph size={15} />Commands</button><button className="f-pill" onClick={() => void toggleFullscreen(panel.id)}>Full screen</button></div>
      {tab === "desktop" ? <DesktopScreen nativeVm panelId={panel.id} name={vm.name} viewer={false} onKeys={setKeys} onFull={() => void toggleFullscreen(panel.id)}>{keys && <span className="vm-note">Keys go to WildOS · Esc Esc to leave</span>}</DesktopScreen> : <div className="vm-commands" onPointerDown={(e) => e.stopPropagation()}><p>Commands run inside the VM. You can also open its terminal on the Desktop.</p><details><summary>Enable the command connection</summary><p>In the VM’s terminal, run this once:</p><pre>{SETUP}</pre><p>Requires a Debian-based guest with systemd.</p></details><label>Guest shell command<textarea aria-label="Guest shell command" value={command} onChange={(e) => setCommand(e.target.value)} maxLength={16000} rows={4} placeholder="uname -a" /></label><button className="f-pill is-accent" disabled={busy || pid !== undefined || !command.trim()} onClick={() => void run()}>Run in VM</button>{pid !== undefined && <p role="status">The command is running. Leaving this tab does not stop it.</p>}{result && <pre className="vm-output" role="status">{result}</pre>}</div>}</> : <div className="vm-rest"><DesktopGlyph size={32} /><h3>{viewer ? "A full OS on this board" : vm.state === "archived" ? "The VM is archived" : "Your operating system, here"}</h3><p>{viewer ? "An editor at their screen can open the VM console. Its status is visible to everyone on this board." : "Start boots its own system. Its disk stays on this computer between runs."}</p><span>{vm.isoName}</span></div>}
  </div>;
}
export function LocalVm({ panel }: { panel: PanelMeta }) { return panel.vm ? <ConfiguredVm panel={panel} /> : <VmSetup panel={panel} />; }
