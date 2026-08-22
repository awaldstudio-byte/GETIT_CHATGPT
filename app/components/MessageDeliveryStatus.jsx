"use client";

const STATUS = {
  queued: { marks: "◷", label: "Queued", tone: "queued" },
  pending: { marks: "◷", label: "Queued", tone: "queued" },
  processing: { marks: "◷", label: "Sending", tone: "queued" },
  suppressed: { marks: "⊘", label: "Not sent — dry run", tone: "suppressed" },
  sent: { marks: "✓", label: "Sent", tone: "sent" },
  delivered: { marks: "✓✓", label: "Delivered", tone: "delivered" },
  read: { marks: "✓✓", label: "Read", tone: "read" },
  failed: { marks: "!", label: "Failed", tone: "failed" },
  dead_letter: { marks: "!", label: "Failed", tone: "failed" },
  cancelled: { marks: "×", label: "Cancelled", tone: "failed" },
};

export default function MessageDeliveryStatus({ message, compact = false }) {
  if (!message || message.direction !== "outbound") return null;
  const status = STATUS[String(message.status || "queued").toLowerCase()] || STATUS.queued;
  return (
    <span className={`delivery-status ${status.tone} ${compact ? "compact" : ""}`} title={status.label} aria-label={status.label}>
      <b aria-hidden="true">{status.marks}</b>
      {!compact && <span>{status.label}</span>}
    </span>
  );
}
