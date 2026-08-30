"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { label } from "../../lib/format";
import { fetchMessagingAttachment, fetchMessagingAttachmentUrls } from "../../lib/messagingMedia";

const fileSize = (value) => {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 1) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
};

export default function MediaAttachment({ attachment, compact = false }) {
  const [objectUrl, setObjectUrl] = useState(null);
  const [downloadUrl, setDownloadUrl] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const mediaRef = useRef(null);
  const mime = String(attachment.mime_type || "").split(";")[0].toLowerCase();

  useEffect(() => {
    let cancelled = false;
    let nextUrl = null;
    setLoading(true);
    setError(null);
    setObjectUrl(null);
    setDownloadUrl(null);

    const open = attachment.retrieval_status === "available" && (mime.startsWith("audio/") || mime.startsWith("video/"))
      ? fetchMessagingAttachmentUrls(attachment.id).then((urls) => ({ previewUrl: urls.preview_url, downloadUrl: urls.download_url }))
      : fetchMessagingAttachment(attachment.id).then((blob) => {
        if (cancelled) return { previewUrl: null, downloadUrl: null };
        nextUrl = URL.createObjectURL(blob);
        return { previewUrl: nextUrl, downloadUrl: nextUrl };
      });

    open
      .then((urls) => {
        if (cancelled) return;
        setObjectUrl(urls.previewUrl);
        setDownloadUrl(urls.downloadUrl);
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
  }, [attachment.id, attachment.archived_at, attachment.retrieval_status, mime]);

  useEffect(() => {
    if (!objectUrl || !mediaRef.current) return;
    mediaRef.current.load();
  }, [objectUrl]);

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
        {downloadUrl && <a href={downloadUrl} download={name} className="small-button">Download</a>}
      </div>
      {attachment.caption && <p className="media-caption">{attachment.caption}</p>}
      {loading ? (
        <span className="media-loading">Opening secure file…</span>
      ) : error ? (
        <span className="media-error">{error}</span>
      ) : mime.startsWith("image/") ? (
        <a href={objectUrl} target="_blank" rel="noreferrer"><img src={objectUrl} alt={attachment.caption || name} loading="lazy" /></a>
      ) : mime.startsWith("audio/") ? (
        <audio key={objectUrl} ref={mediaRef} controls preload="metadata">
          <source src={objectUrl} type={attachment.mime_type || "audio/ogg"} />
          Your browser cannot play this voice note.
        </audio>
      ) : mime.startsWith("video/") ? (
        <video key={objectUrl} ref={mediaRef} controls preload="metadata">
          <source src={objectUrl} type={attachment.mime_type || "video/mp4"} />
          Your browser cannot play this video.
        </video>
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
