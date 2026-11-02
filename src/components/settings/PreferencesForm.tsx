"use client";

import { useActionState } from "react";
import { savePreferencesAction, type PrefsState } from "@/app/(app)/settings/actions";

export interface PrefsValues {
  morningSummaryTime: string;
  eveningCheckEnabled: boolean;
  eveningCheckTime: string;
  quietStart: string;
  quietEnd: string;
  maxOtherPerDay: number;
  urgentAtNight: boolean;
}

function FieldError({ state, name }: { state: PrefsState; name: string }) {
  const msg = state.fieldErrors?.[name]?.[0];
  return msg ? <p className="mt-1 text-[12px] text-risk">{msg}</p> : null;
}

export function PreferencesForm({ prefs, timeZone }: { prefs: PrefsValues; timeZone: string }) {
  const [state, action, pending] = useActionState<PrefsState, FormData>(savePreferencesAction, {});
  return (
    <form action={action} aria-label="Notification preferences" className="flex flex-col gap-4">
      <p className="text-[12px] text-muted">All times are {timeZone} (GMT+6).</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="label">Morning summary</span>
          <input type="time" name="morningSummaryTime" defaultValue={prefs.morningSummaryTime} required className="input" />
          <FieldError state={state} name="morningSummaryTime" />
        </label>
        <div className="flex flex-col gap-1">
          <span className="label">Evening check</span>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-[13px]">
              <input type="checkbox" name="eveningCheckEnabled" defaultChecked={prefs.eveningCheckEnabled} /> On
            </label>
            <input
              type="time"
              name="eveningCheckTime"
              aria-label="Evening check time"
              defaultValue={prefs.eveningCheckTime}
              required
              className="input flex-1"
            />
          </div>
          <FieldError state={state} name="eveningCheckTime" />
        </div>
        <div className="flex flex-col gap-1">
          <span className="label">Quiet hours (nothing is sent)</span>
          <div className="flex items-center gap-2">
            <input type="time" name="quietStart" aria-label="Quiet hours start" defaultValue={prefs.quietStart} required className="input flex-1" />
            <span className="text-muted">to</span>
            <input type="time" name="quietEnd" aria-label="Quiet hours end" defaultValue={prefs.quietEnd} required className="input flex-1" />
          </div>
          <FieldError state={state} name="quietStart" />
          <FieldError state={state} name="quietEnd" />
        </div>
        <label className="flex flex-col gap-1">
          <span className="label">Other pushes per day</span>
          <input
            type="number"
            name="maxOtherPerDay"
            min={0}
            max={10}
            defaultValue={prefs.maxOtherPerDay}
            required
            className="input num"
          />
          <span className="text-[12px] text-muted">Besides the two summaries. Extra reminders wait for the next summary.</span>
          <FieldError state={state} name="maxOtherPerDay" />
        </label>
      </div>
      <label className="flex items-start gap-2 text-[13px]">
        <input type="checkbox" name="urgentAtNight" defaultChecked={prefs.urgentAtNight} className="mt-0.5" />
        <span>
          <span className="font-medium">Urgent at night</span>
          <span className="block text-muted">Let urgent items through during quiet hours. Off by default.</span>
        </span>
      </label>
      <div className="flex items-center gap-3">
        <button type="submit" className="btn btn-primary" disabled={pending}>
          Save preferences
        </button>
        {state.ok && <span className="text-[13px] text-accent" role="status">Saved</span>}
        {state.error && <span className="text-[13px] text-risk">{state.error}</span>}
      </div>
    </form>
  );
}
