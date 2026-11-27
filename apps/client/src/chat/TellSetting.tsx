/**
 * Settings → General → Notifications: whether this device shows a desktop notification when someone mentions me
 * or writes to me directly (chat/notify.ts). Off until a person turns it on; the browser's own question is asked
 * from that press and never on load. *Only mentions and direct messages* is the one mode for now; each
 * conversation's own *Tell me about* (Everything · Mentions · Nothing) still applies, and Nothing is never told.
 */

import { useState } from "react";
import { Row, Seg } from "../settings/SettingsSpace";
import { setTell, useTell } from "./notify";
import type { TellPermission } from "./notifyLogic";
import { playPing, setSound, useSound } from "./pingSound";

export function tellDetail(on: boolean, permission: TellPermission, refused: boolean): string {
  if (permission === "unsupported") return "This window can't show desktop notifications. The bell in the top bar still counts what's said to you.";
  if (permission === "denied") return `${refused ? "This device said no. " : ""}Notifications are blocked for Foundation in the browser's or the system's settings. Allow them there, then turn this on. The bell in the top bar still counts what's said to you.`;
  if (on) return "On for this device: when someone mentions you or writes to you directly and you aren't looking at that conversation, a notification says who and the first line. Conversations you set to Nothing stay quiet.";
  return "Off. The bell in the top bar still counts what's said to you. Turning this on asks this device's permission, once.";
}

export function TellSettingView({ on, permission, refused = false, onChange }: { on: boolean; permission: TellPermission; refused?: boolean; onChange(on: boolean): void }) {
  const can = permission !== "unsupported" && permission !== "denied";
  return (
    <Row name="Mentions and direct messages" detail={<span data-tell-detail>{tellDetail(on, permission, refused)}</span>}>
      <Seg
        label="Desktop notifications for mentions and direct messages"
        value={on && permission === "granted" ? "on" : "off"}
        disabled={!can}
        options={[
          { id: "on", label: "Tell me" },
          { id: "off", label: "Off" },
        ]}
        onChange={(v) => onChange(v === "on")}
      />
    </Row>
  );
}

export function TellSetting() {
  const t = useTell();
  const [refused, setRefused] = useState(false);
  return <TellSettingView on={t.on} permission={t.permission} refused={refused} onChange={(on) => void setTell(on).then((p) => setRefused(on && p !== "granted"))} />;
}

/** the ping's sound (chat/pingSound.ts): on unless turned off here; choosing On plays it once */
export function SoundSettingView({ on, onChange }: { on: boolean; onChange(on: boolean): void }) {
  return (
    <Row
      name="A sound when you're pinged"
      detail={<span data-sound-detail>{on ? "On for this device: a soft two-note chime when someone mentions you or writes to you directly and you aren't looking at that conversation." : "Off. Mentions still light the bell."}</span>}
    >
      <Seg
        label="A sound for mentions and direct messages"
        value={on ? "on" : "off"}
        options={[
          { id: "on", label: "Sound" },
          { id: "off", label: "Off" },
        ]}
        onChange={(v) => onChange(v === "on")}
      />
    </Row>
  );
}

export function SoundSetting() {
  const on = useSound();
  return <SoundSettingView on={on} onChange={(v) => (setSound(v), v && playPing(true))} />;
}
