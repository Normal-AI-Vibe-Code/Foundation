import type { Router, Req } from "./http.ts";
import { HttpError, readJson } from "./http.ts";
import { requirePerson, requireUser } from "./auth.ts";
import { canSeeBoard } from "./members.ts";
import { requireWriter } from "./roles.ts";
import { uploadVmIso, listFiles } from "./files.ts";
import { configureVm, vmHost, vmStatus, vmAction, vmConsole, runVmCommand, vmCommandResult } from "./localvms.ts";

/** Exported for HTTP tests: the production router installs exactly these handlers. */
export function registerVmRoutes(r: Router) {
  const member = (req: Req) => {
    const user = requireUser(req);
    if (!canSeeBoard(user, req.params.id)) throw new HttpError(404, "No such board");
    return user;
  };
  const person = (req: Req) => {
    const u = requirePerson(req, "Controlling a full OS VM");
    member(req); requireWriter(u, req.params.id); return u;
  };
  r.get("/api/vms/host", (req) => { requireUser(req); return vmHost(); });
  r.get("/api/boards/:id/vm-isos", (req) => { member(req); return { files: listFiles(req.params.id).filter((f) => /\.iso$/i.test(f.name)) }; });
  r.post("/api/boards/:id/vm-isos", async (req) => { const u = person(req); return { file: await uploadVmIso(req, req.params.id, u.id) }; });
  r.post("/api/boards/:id/vms/:panel/configure", async (req) => { const u = person(req); return { vm: configureVm(req.params.id, req.params.panel, await readJson(req), u) }; });
  r.get("/api/boards/:id/vms/:panel", async (req) => { member(req); return { vm: await vmStatus(req.params.id, req.params.panel) }; });
  r.post("/api/boards/:id/vms/:panel/console", (req) => { person(req); return vmConsole(req.params.id, req.params.panel); });
  r.post("/api/boards/:id/vms/:panel/commands", async (req) => { const u = person(req); const b = await readJson(req); return runVmCommand(req.params.id, req.params.panel, b.command, b.request_id, u); });
  r.get("/api/boards/:id/vms/:panel/commands/:command", async (req) => { member(req); return vmCommandResult(req.params.id, req.params.panel, req.params.command); });
  for (const action of ["start", "shutdown", "poweroff", "boot", "resources", "archive", "restore"]) r.post(`/api/boards/:id/vms/:panel/${action}`, async (req) => { const u = person(req); return { vm: await vmAction(req.params.id, req.params.panel, action, await readJson(req), u) }; });
}
