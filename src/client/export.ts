import type { CreateNote } from "../shared/contracts";
export function filename(title: string) {
  return (
    (title
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 76)
      .replace(/-$/g, "") || "voice-note") + ".md"
  );
}
export function markdown(
  note: Pick<CreateNote, "title" | "body">,
  created: string,
) {
  return `---\ntitle: ${JSON.stringify(note.title || "Voice note")}\ncreated: ${JSON.stringify(created)}\ntags: [voice]\nrelated: []\n---\n\n${note.body}\n`;
}
export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function exportNote(
  note: Pick<CreateNote, "title" | "body">,
  created: string,
) {
  download(
    new Blob([markdown(note, created)], {
      type: "text/markdown;charset=utf-8",
    }),
    filename(note.title),
  );
}
export function duration(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)
    .toString()
    .padStart(2, "0")}:${(s % 60).toString().padStart(2, "0")}`;
}
