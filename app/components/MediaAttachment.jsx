"use client";

import { useEffect, useMemo, useState } from "react";
import { label } from "../../lib/format";
import { fetchMessagingAttachment } from "../../lib/messagingMedia";

const fileSize = (value) => {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 1) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
};

export default function MediaAttachment({ attachment, compact = false }) {
  const [objectUrl, setObjectUrl] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    let nextUrl = null;
    setLoading(true);
    setError(null);
    setObjectUrl(null);

    fetchMessagingAttachment(attachment.id)
      .then((blob) => {
        if (cancelled) return;
        nextUrl = URL.createObjectURL(blob);
        setObjectUrl(nextUrl);
      })
      .catch((nextError) => {
        if (!cancelled) setError(nextError.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      if (nextUrl) URL.revokeObjectURL(nextUrl);
    };
  }, [attachment.id, attachment.archived_at, attachment.retrieval_status]);

  const mime = String(attachment.mime_type || "").split(";")[0].toLowerCase();
  const name = attachment.file_name || `${label(attachment.attachment_type)} attachment`;
  const meta = useMemo(() => [
    label(attachment.attachment_type),
    fileSize(attachment.file_size_bytes),
    attachment.retrieval_status === "available" ? "Archived securely" : "Provider recovery copy",
  ].filter(Boolean).join(" · "), [attachment]);

  return (
    <section className={`media-attachment ${compact ? "compact" : ""}`}>
      <div className="media-attachment-heading">
        <div><strong>{name}</strong><span>{meta}</span></div>
        {objectUrl && <a href={objectUrl} download={name} className="small-button">Download</a>}
      </div>
      {attachment.caption && <p className="media-caption">{attachment.caption}</p>}
      {loading ? (
        <span className="media-loading">Opening secure file…</span>
      ) : error ? (
        <span className="media-error">{error}</span>
      ) : mime.startsWith("image/") ? (
        <a href={objectUrl} target="_blank" rel="noreferrer"><img src={objectUrl} alt={attachment.caption || name} loading="lazy" /></a>
      ) : mime.startsWith("audio/") ? (
        <audio controls preload="metadata" src={objectUrl}>Your browser cannot play this voice note.</audio>
      ) : mime.startsWith("video/") ? (
        <video controls preload="metadata" src={objectUrl}>Your browser cannot play this video.</video>
      ) : mime === "application/pdf" ? (
        <a href={objectUrl} target="_blank" rel="noreferrer" className="media-open-file">Open PDF securely</a>
      ) : (
        <a href={objectUrl} download={name} className="media-open-file">Download file securely</a>
      )}
      {attachment.is_voice && (
        <div className="media-transcript">
          <strong>Voice transcription</strong>
          <span>{attachment.transcription_text || (attachment.transcription_status === "complete" ? "Transcript is shown as the message text above." : attachment.transcription_error || "Transcription pending")}</span>
        </div>
      )}
    </section>
  );
}
