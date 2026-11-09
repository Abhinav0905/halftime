// Booth QR code, rendered on the server as an inline SVG so it prints sharply
// and works without client JavaScript.

import QRCode from "qrcode";
import { cx } from "./ui";

export async function QrCode({ value, label, className }: { value: string; label: string; className?: string }) {
  const svg = await QRCode.toString(value, {
    type: "svg",
    margin: 1,
    errorCorrectionLevel: "M",
    color: { dark: "#13203aff", light: "#ffffffff" },
  });
  return (
    <div
      role="img"
      aria-label={label}
      className={cx("aspect-square w-full [&>svg]:block [&>svg]:h-full [&>svg]:w-full", className)}
      // The SVG comes from the qrcode library, not from user input.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
