// loadPdf(bytes): set up the pdfjs worker (bundled, no CDN — PLAN §5.8/§10.5)
// and open the document. cMaps + standard fonts are served from /public so
// rendering is fully offline.
import * as pdfjsLib from "pdfjs-dist";
// Vite bundles the worker file and gives us a URL to it (?url) — no CDN fetch.
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PdfDoc } from "./types";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

export async function loadPdf(bytes: Uint8Array): Promise<PdfDoc> {
  // pdfjs detaches the buffer it's handed; pass a fresh copy so the caller's
  // bytes stay usable (e.g. for hashing).
  const data = bytes.slice();
  const task = pdfjsLib.getDocument({
    data,
    cMapUrl: "/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/standard_fonts/",
    // Disable the (Node-only) eval-based font path; WKWebView is fine without it.
    isEvalSupported: false,
  });
  const doc = await task.promise;
  return {
    numPages: doc.numPages,
    raw: doc,
    getPage: (n: number) => doc.getPage(n),
  };
}

/**
 * Unscaled {width, height} per page (PDF units at scale 1). Used by the viewer
 * to size the virtualized list before rendering each canvas.
 */
export async function getPageSizes(
  doc: PdfDoc,
): Promise<{ width: number; height: number }[]> {
  const sizes: { width: number; height: number }[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page: any = await doc.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    sizes.push({ width: vp.width, height: vp.height });
  }
  return sizes;
}
