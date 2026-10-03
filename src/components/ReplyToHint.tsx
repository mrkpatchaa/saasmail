import { cn } from "@/lib/utils";

interface ReplyToHintProps {
  /** Where the reply goes when it follows the message's Reply-To. */
  replyTo: string;
  /** True when the user chose to answer the sender instead. */
  toSender: boolean;
  onToggle: (toSender: boolean) => void;
  className?: string;
}

/**
 * Shown by the reply composers when the message being answered asked for
 * replies at another address: says where the reply will go and lets the user
 * answer the sender instead.
 */
export default function ReplyToHint({
  replyTo,
  toSender,
  onToggle,
  className,
}: ReplyToHintProps) {
  return (
    <div
      data-testid="reply-to-hint"
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-secondary",
        className,
      )}
    >
      <span>
        {toSender
          ? `This reply goes to the sender, not ${replyTo}`
          : `Replies go to ${replyTo} (the sender asked for replies there)`}
      </span>
      <label className="inline-flex cursor-pointer items-center gap-1.5 font-medium text-text-primary">
        <input
          type="checkbox"
          checked={toSender}
          onChange={(event) => onToggle(event.target.checked)}
          className="h-3 w-3 accent-text-primary"
        />
        Reply to the sender instead
      </label>
    </div>
  );
}
