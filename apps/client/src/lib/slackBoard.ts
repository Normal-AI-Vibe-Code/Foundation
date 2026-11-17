/**
 * The Slack board: one space with a section for every Slack channel, each
 * kept current with its channel (server: slacklive.ts). Making it again
 * opens the one there is and picks up channels made since.
 */
import { api } from "./api";
import { toast } from "../state/ui";

export async function openSlackBoard() {
  try {
    const r = await api<{ id: string; made: boolean; channels: number; reading: number; waiting: number }>("/api/slack/board", { method: "POST" });
    window.dispatchEvent(new Event("foundation:boards"));
    window.dispatchEvent(new CustomEvent("foundation:board", { detail: r.id }));
    const waiting = r.waiting ? ` · ${r.waiting} wait for the Slack app to be invited` : "";
    toast(`${r.made ? "Made the Slack board" : "The Slack board"}: ${r.channels} channels, ${r.reading} being read${waiting}`, "ok");
  } catch (e) {
    toast((e as Error).message, "bad");
  }
}
