import { useEffect, useState } from "react";
import { fetchAdminSettings, updateAdminSettings } from "@/lib/api";

/** Inboxes (admins): refuse mail to addresses that aren't inboxes. */
export default function UnknownRecipientsSetting() {
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchAdminSettings()
      .then((settings) => setOn(settings.rejectUnknownRecipients))
      .catch(() => setError("Could not load this setting."));
  }, []);

  async function toggle(next: boolean) {
    setBusy(true);
    setError(null);
    try {
      const settings = await updateAdminSettings({
        rejectUnknownRecipients: next,
      });
      setOn(settings.rejectUnknownRecipients);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save this setting.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-8 max-w-3xl rounded-[8px] bg-card p-5 ring-1 ring-border">
      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={on === true}
          disabled={on === null || busy}
          onChange={(event) => void toggle(event.target.checked)}
          aria-describedby="unknown-recipients-hint"
        />
        <span>
          <span className="block text-sm font-medium text-text-primary">
            Reject mail to addresses that aren&apos;t inboxes
          </span>
          <span
            id="unknown-recipients-hint"
            className="mt-1 block text-xs font-light text-text-secondary"
          >
            The sending server is told &quot;No such mailbox&quot; and nothing
            is stored. Off, mail to any address under your routed domains is
            stored (catch-all).
          </span>
        </span>
      </label>
      {error && (
        <p role="alert" className="mt-3 text-xs text-red-600">
          {error}
        </p>
      )}
    </section>
  );
}
