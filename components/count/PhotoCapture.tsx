"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Callout, buttonClass, cx } from "@/components/ui";

const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.85;
const ACCEPTED = new Set(["image/jpeg", "image/png", "image/webp"]);
// Files already this small are sent unchanged, so a prepared demo photo keeps
// its SHA-256 and replay mode can find its recorded count.
const PASS_THROUGH_BYTES = 2.5 * 1024 * 1024;

type Purpose = "open" | "close" | "slip" | "receipt";

type State =
  | { step: "idle" }
  | { step: "preparing" }
  | { step: "uploading"; progress: number }
  | { step: "done" }
  | { step: "error"; message: string };

async function decode(file: File): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  try {
    // createImageBitmap applies the EXIF rotation, so phone photos come out upright.
    const bmp = await createImageBitmap(file);
    return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => {} };
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

/** Downscale to at most 1600 px on the long edge as JPEG. Re-encoding also drops EXIF data such as location. */
export async function preparePhoto(file: File): Promise<Blob> {
  const img = await decode(file).catch(() => {
    throw new Error("This photo could not be opened. Try taking it again.");
  });
  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
    if (scale === 1 && ACCEPTED.has(file.type) && file.size <= PASS_THROUGH_BYTES) return file;

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) throw new Error("This browser could not prepare the photo.");
    ctx2d.imageSmoothingQuality = "high";
    ctx2d.drawImage(img.source, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
    if (!blob) throw new Error("This browser could not prepare the photo.");
    return blob;
  } finally {
    img.close();
  }
}

function upload(nightId: string, purpose: Purpose, blob: Blob, onProgress: (p: number) => void): Promise<{ sha256: string; url: string }> {
  // XMLHttpRequest rather than fetch: it reports upload progress, which matters on stadium cell signal.
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("purpose", purpose);
    form.append("file", blob, blob.type === "image/jpeg" ? "photo.jpg" : "photo");
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/nights/${encodeURIComponent(nightId)}/photos`);
    xhr.responseType = "json";
    xhr.timeout = 60_000;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      const body = xhr.response as { sha256?: string; url?: string; error?: string } | null;
      if (xhr.status === 201 && body?.sha256 && body.url) resolve({ sha256: body.sha256, url: body.url });
      else reject(new Error(body?.error ?? `The upload failed (HTTP ${xhr.status}).`));
    };
    xhr.onerror = () => reject(new Error("The upload did not reach the server. Check the signal and try again."));
    xhr.ontimeout = () => reject(new Error("The upload took too long. Check the signal and try again."));
    xhr.send(form);
  });
}

export function PhotoCapture({
  nightId,
  purpose,
  onUploaded,
  label = "Take photo",
}: {
  nightId: string;
  purpose: Purpose;
  onUploaded: (p: { sha256: string; url: string }) => void;
  label?: string;
}) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<State>({ step: "idle" });
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview);
    };
  }, [preview]);

  async function onFile(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setState({ step: "error", message: "Please choose a photo." });
      return;
    }
    setState({ step: "preparing" });
    try {
      const blob = await preparePhoto(file);
      setPreview(URL.createObjectURL(blob));
      setState({ step: "uploading", progress: 0 });
      const saved = await upload(nightId, purpose, blob, (progress) => setState({ step: "uploading", progress }));
      setState({ step: "done" });
      onUploaded(saved);
    } catch (err) {
      setState({ step: "error", message: (err as Error).message });
    } finally {
      // Clear the input so choosing the same file again still fires onChange.
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  const busy = state.step === "preparing" || state.step === "uploading";

  return (
    <div className="space-y-3">
      {preview && (
        <div className="relative overflow-hidden rounded-lg border border-line bg-paper">
          <img src={preview} alt="The photo you just took" className={cx("block h-auto w-full", busy && "opacity-60")} />
          {state.step === "uploading" && (
            <div className="absolute inset-x-0 bottom-0 h-1.5 bg-white/60">
              <div className="h-full bg-brand transition-[width]" style={{ width: `${Math.round(state.progress * 100)}%` }} />
            </div>
          )}
        </div>
      )}

      <input
        ref={inputRef}
        id={inputId}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        disabled={busy}
        onChange={(e) => onFile(e.target.files?.[0])}
      />
      <label
        htmlFor={inputId}
        aria-disabled={busy}
        className={cx(buttonClass(preview ? "secondary" : "primary", "lg"), "w-full cursor-pointer", busy && "pointer-events-none opacity-60")}
      >
        {state.step === "preparing" && "Preparing photo…"}
        {state.step === "uploading" && `Uploading… ${Math.round(state.progress * 100)}%`}
        {!busy && (preview ? "Retake photo" : label)}
      </label>

      <p role="status" aria-live="polite" className="sr-only">
        {state.step === "uploading" ? "Uploading photo" : state.step === "done" ? "Photo uploaded" : ""}
      </p>
      {state.step === "error" && <Callout tone="bad" title="The photo was not saved">{state.message}</Callout>}
    </div>
  );
}
