import { supabase } from "./supabase";

export async function fetchMessagingAttachment(attachmentId) {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  if (!data.session?.access_token) {
    throw new Error("Your staff session expired. Sign in again to open this file.");
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const response = await fetch(
    `${supabaseUrl}/functions/v1/messaging-media-access?attachment_id=${encodeURIComponent(attachmentId)}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${data.session.access_token}`,
        apikey: publishableKey,
      },
      cache: "no-store",
    },
  );

  if (!response.ok) {
    let detail = null;
    try { detail = await response.json(); } catch { detail = null; }
    const code = detail?.code ? detail.code.replaceAll("_", " ").toLowerCase() : null;
    throw new Error(code ? `File unavailable: ${code}` : "This file could not be opened.");
  }

  const blob = await response.blob();
  if (!blob.size) throw new Error("The stored file is empty.");
  return blob;
}
